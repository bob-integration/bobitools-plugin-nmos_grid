# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 BOBI SAS, France
# Auteur : Cyril Mazouer, pour le compte de BOBI SAS
# Distribué sous licence GNU GPL v3 (ou ultérieure) ; voir le fichier LICENSE.

"""Serveur de l'outil « Grille NMOS » (runtime=docker) — routeur logiciel ST 2110 sur NMOS.

HTTP minimal (ThreadingHTTPServer, stdlib), proxifié par l'app sous /api/tools/nmos_grid/*.

Idée : une matrice X/Y « à la Probel/router de régie » par-dessus NMOS IS-04/IS-05.
  - Colonnes = senders (sources), lignes = receivers (destinations), énumérés en parcourant
    les nodes IS-04 du parc (repris du volume RO de bmd_nmos, + cibles manuelles).
  - Un croisement ACTIF = le receiver est actuellement abonné à ce sender. La corrélation se
    fait via IS-05 /single/receivers/<id>/active : d'abord `sender_id` s'il est exposé, sinon
    l'adresse multicast:port (repli robuste pour les nodes qui n'exposent pas sender_id).
  - TAKE = on récupère le transportfile (SDP) du sender puis on PATCH le staged du receiver
    (transport_file + activation_mode: activate_immediate + master_enable:true). Déconnexion =
    master_enable:false.
  - Salvos : ensembles nommés de croisements, persistés dans /data, applicables d'un clic avec
    rapport succès/échec par croisement.
  - Snapshots : photo du ROUTAGE COMPLET courant (chaque receiver et sa source, déconnexions
    comprises), rappelable par ré-application.

GROUPEMENT PAR SIGNAL (BCP-002-01 « Natural Grouping ») : chaque sender/receiver porte un champ
`group` {name, role, inferred}. Deux origines :
  - GROUPHINT (IS-04) : lu par nmos.py dans le tag `urn:x-nmos:tag:grouphint/v1.0`
    (« <nom du groupe>:<rôle> », ex. « SDI 1:VIDEO ») → inferred:false.
  - REPLI HEURISTIQUE : quand le node ne pose pas de grouphint, on déduit le groupe du préfixe
    commun des libellés d'une même machine, une fois l'essence retirée (« Vidéo », « Audio 1 »,
    « ANC »…). Un préfixe partagé par ≥ 2 signaux fait un groupe marqué inferred:true. Un signal
    sans grouphint ni préfixe partageable reste ORPHELIN (group:null), affiché seul.
Take/déconnexion groupés (`/take-group`, `/disconnect-group`) apparient les essences entre deux
groupes (video↔video, audio↔audio par rôle/ordre, data/anc↔data) et rendent un rapport par paire.

MODE SIMULATION : si l'inventaire bmd_nmos est absent/vide ET qu'aucun node manuel n'est
déclaré, l'outil bascule sur un PARC SIMULÉ dont l'état de routage est persisté dans
/data/sim_routing.json. Le parc démo exerce les deux vues : machines à grouphints (SDI 1/2,
MV IN 1/2 avec vidéo + audios + ANC), une machine SANS grouphint (heuristique par préfixe) et un
signal orphelin. Toute l'UI — takes, takes groupés, salvos, snapshots — est ainsi testable sans
matériel (inspiré du « switch simulé » de switch_ports).
"""
import json
import os
import re
import threading
import time
import uuid
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

from nmos import NmosNode, NmosError, parse_sdp_legs

DATA_DIR = os.environ.get("DATA_DIR", "/data")
BMD_DIR = os.environ.get("BMD_DIR", "/bmd")               # volume RO du parc bmd_nmos
TARGETS_FILE = os.path.join(DATA_DIR, "targets.json")     # nodes NMOS manuels
SALVOS_FILE = os.path.join(DATA_DIR, "salvos.json")
SNAPSHOTS_FILE = os.path.join(DATA_DIR, "snapshots.json")
SIM_ROUTING_FILE = os.path.join(DATA_DIR, "sim_routing.json")

# Ports NMOS par défaut des convertisseurs BMD (un node par cage SFP, cf. bmd_nmos).
_BMD_DEFAULT = {"base_port": 8090, "step": 2, "count": 4}

_io_lock = threading.Lock()

# Cache léger de la grille (le rafraîchissement périodique de l'UI ne re-sonde pas le parc
# à chaque tick). Invalidé après tout take/déconnexion.
_grid_cache = {"data": None, "ts": 0.0}
_grid_lock = threading.Lock()
GRID_TTL = 4.0


# --------------------------------------------------------------------------- persistance

def _read(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, ValueError):
        return default


def _write(path, data):
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)  # atomique sur POSIX


def _load_list(path):
    with _io_lock:
        d = _read(path, [])
        return d if isinstance(d, list) else []


def _save_list(path, data):
    with _io_lock:
        _write(path, data)


def load_targets():
    return _load_list(TARGETS_FILE)


def save_targets(t):
    _save_list(TARGETS_FILE, t)


def load_salvos():
    return _load_list(SALVOS_FILE)


def save_salvos(s):
    _save_list(SALVOS_FILE, s)


def load_snapshots():
    return _load_list(SNAPSHOTS_FILE)


def save_snapshots(s):
    _save_list(SNAPSHOTS_FILE, s)


def load_sim_routing():
    with _io_lock:
        d = _read(SIM_ROUTING_FILE, {})
        return d if isinstance(d, dict) else {}


def save_sim_routing(r):
    with _io_lock:
        _write(SIM_ROUTING_FILE, r)


# --------------------------------------------------------------------------- groupement (BCP-002-01)

# Mots d'essence reconnus en fin de libellé pour le REPLI HEURISTIQUE (FR + EN), suivis d'un
# numéro optionnel. Le préfixe restant (une fois ce suffixe retiré) est le nom du groupe déduit.
_ESS_WORDS = r"(?:vid[eé]o|video|vid|audio|aud|son|anc|data|metadata|meta)"
_STRIP_RE = re.compile(r"^(?P<prefix>.*\S)[\s·:•\-–—/]+(?P<suf>" + _ESS_WORDS + r"\s*\d*)$",
                       re.IGNORECASE)

# Ordre d'appariement des essences pour les takes groupés (video d'abord, puis audio, puis data).
_ESSENCE_ORDER = {"video": 0, "audio": 1, "data": 2}


def _strip_essence(label):
    """« CONV Retour Vidéo » → ('CONV Retour', 'VIDÉO'). (None, None) si pas de suffixe d'essence."""
    m = _STRIP_RE.match((label or "").strip())
    if not m:
        return None, None
    return m.group("prefix").strip(), m.group("suf").strip().upper()


def annotate_groups(items):
    """Complète le champ `group` des ressources SANS grouphint par REPLI HEURISTIQUE : au sein
    d'une même machine, un préfixe de libellé partagé par ≥ 2 signaux (essence retirée) forme un
    groupe marqué inferred:true. Les ressources déjà groupées (grouphint) ne sont pas touchées."""
    by_machine = defaultdict(list)
    for it in items:
        by_machine[it.get("machine_key")].append(it)
    for members in by_machine.values():
        buckets, roles = defaultdict(list), {}
        for it in members:
            if it.get("group"):                       # grouphint : on ne déduit rien
                continue
            prefix, role = _strip_essence(it.get("label", ""))
            if prefix:
                buckets[prefix].append(it)
                roles[id(it)] = role
        for prefix, grp in buckets.items():
            if len(grp) >= 2:                         # un singleton ne « regroupe » rien
                for it in grp:
                    it["group"] = {"name": prefix, "role": roles.get(id(it), ""), "inferred": True}
    return items


def _role_key(item):
    g = item.get("group") or {}
    return (str(g.get("role") or ""), str(item.get("label") or ""))


def _pair_group(receivers, senders):
    """Apparie les essences entre un groupe de receivers et un groupe de senders (video↔video,
    audio↔audio par rôle/ordre, data↔data). Renvoie (pairs, unmatched_receivers) où
    pairs = [(receiver, sender, essence)] et unmatched = receivers sans sender correspondant."""
    br, bs = defaultdict(list), defaultdict(list)
    for r in receivers:
        br[r.get("essence") or ""].append(r)
    for s in senders:
        bs[s.get("essence") or ""].append(s)
    pairs, unmatched = [], []
    for ess in sorted(set(br) | set(bs), key=lambda e: _ESSENCE_ORDER.get(e, 9)):
        rs = sorted(br.get(ess, []), key=_role_key)
        ss = sorted(bs.get(ess, []), key=_role_key)
        n = min(len(rs), len(ss))
        for i in range(n):
            pairs.append((rs[i], ss[i], ess))
        unmatched.extend(rs[n:])                       # receivers en trop = pas de correspondance
    return pairs, unmatched


def _resolve_group(grid, side, sel):
    """Membres d'un groupe désigné par {machine_key, name} dans la grille courante."""
    if not isinstance(sel, dict):
        return []
    mk, name = sel.get("machine_key"), sel.get("name")
    items = grid["receivers"] if side == "r" else grid["senders"]
    return [x for x in items
            if x.get("machine_key") == mk and (x.get("group") or {}).get("name") == name]


# --------------------------------------------------------------------------- parc simulé

# Parc démo. Adresses multicast fictives. Le champ optionnel "group" = [nom, rôle] émule un
# grouphint BCP-002-01 (inferred:false). Les machines qui n'en portent pas exercent le repli
# heuristique ; « Mire » est un signal ORPHELIN (aucun groupe).
SIM_PARC = [
    # Machine à GROUPHINT, côté sources : deux signaux SDI complets (V + 2 audios + ANC).
    {"id": "sdi", "name": "Régie SDI", "host": "10.20.0.10",
     "senders": [
         {"id": "sdi1-v", "label": "SDI 1 · Vidéo", "essence": "video", "mcast": "239.20.1.1", "port": 5004, "group": ["SDI 1", "VIDEO"]},
         {"id": "sdi1-a1", "label": "SDI 1 · Audio 1", "essence": "audio", "mcast": "239.20.1.2", "port": 5004, "group": ["SDI 1", "AUDIO 1"]},
         {"id": "sdi1-a2", "label": "SDI 1 · Audio 2", "essence": "audio", "mcast": "239.20.1.3", "port": 5004, "group": ["SDI 1", "AUDIO 2"]},
         {"id": "sdi1-anc", "label": "SDI 1 · ANC", "essence": "data", "mcast": "239.20.1.4", "port": 5004, "group": ["SDI 1", "ANC"]},
         {"id": "sdi2-v", "label": "SDI 2 · Vidéo", "essence": "video", "mcast": "239.20.1.5", "port": 5004, "group": ["SDI 2", "VIDEO"]},
         {"id": "sdi2-a1", "label": "SDI 2 · Audio 1", "essence": "audio", "mcast": "239.20.1.6", "port": 5004, "group": ["SDI 2", "AUDIO 1"]},
     ],
     "receivers": []},
    # Machine à GROUPHINT, côté destinations : entrées multiviewer signalisées complètes.
    {"id": "mv", "name": "Multiviewer", "host": "10.20.0.30",
     "senders": [],
     "receivers": [
         {"id": "mvin1-v", "label": "MV IN 1 · Vidéo", "essence": "video", "group": ["MV IN 1", "VIDEO"]},
         {"id": "mvin1-a1", "label": "MV IN 1 · Audio 1", "essence": "audio", "group": ["MV IN 1", "AUDIO 1"]},
         {"id": "mvin1-a2", "label": "MV IN 1 · Audio 2", "essence": "audio", "group": ["MV IN 1", "AUDIO 2"]},
         {"id": "mvin1-anc", "label": "MV IN 1 · ANC", "essence": "data", "group": ["MV IN 1", "ANC"]},
         {"id": "mvin2-v", "label": "MV IN 2 · Vidéo", "essence": "video", "group": ["MV IN 2", "VIDEO"]},
         {"id": "mvin2-a1", "label": "MV IN 2 · Audio 1", "essence": "audio", "group": ["MV IN 2", "AUDIO 1"]},
     ]},
    # Machine SANS grouphint : libellés à préfixe commun → groupes DÉDUITS (inferred:true).
    # « Mire » n'a pas de suffixe d'essence → reste orphelin.
    {"id": "conv", "name": "Convertisseur", "host": "10.20.0.40",
     "senders": [
         {"id": "conv-v", "label": "CONV Vidéo", "essence": "video", "mcast": "239.20.4.1", "port": 5004},
         {"id": "conv-a", "label": "CONV Audio", "essence": "audio", "mcast": "239.20.4.2", "port": 5004},
         {"id": "mire", "label": "Mire", "essence": "video", "mcast": "239.20.4.9", "port": 5004},
     ],
     "receivers": [
         {"id": "conv-in-v", "label": "CONV Retour Vidéo", "essence": "video"},
         {"id": "conv-in-a", "label": "CONV Retour Audio", "essence": "audio"},
     ]},
]


def _sim_sender(sender_key):
    """Retrouve un sender simulé par sa clé (node_key|id)."""
    for m in SIM_PARC:
        nk = f"sim:{m['id']}"
        for s in m["senders"]:
            if f"{nk}|{s['id']}" == sender_key:
                return m, s
    return None, None


def _sim_receiver(receiver_key):
    for m in SIM_PARC:
        nk = f"sim:{m['id']}"
        for r in m["receivers"]:
            if f"{nk}|{r['id']}" == receiver_key:
                return m, r
    return None, None


def _sim_group(x):
    """Émule un grouphint (inferred:false) depuis le champ optionnel [nom, rôle] du parc démo."""
    g = x.get("group")
    return {"name": g[0], "role": g[1], "inferred": False} if g else None


def _sim_grid():
    routing = load_sim_routing()
    machines, senders, receivers = [], [], []
    for m in SIM_PARC:
        nk = f"sim:{m['id']}"
        machines.append({"key": nk, "name": m["name"], "source": "sim", "reachable": True})
        for s in m["senders"]:
            senders.append({
                "key": f"{nk}|{s['id']}", "id": s["id"], "node_key": nk, "machine_key": nk,
                "machine": m["name"], "host": m["host"], "port": 0, "label": s["label"],
                "essence": s["essence"], "group": _sim_group(s), "master_enable": True,
                "dest_ip": s["mcast"], "dest_port": s.get("port", 5004), "source_ip": m["host"]})
        for r in m["receivers"]:
            rk = f"{nk}|{r['id']}"
            sk = routing.get(rk)
            _, snd = _sim_sender(sk) if sk else (None, None)
            receivers.append({
                "key": rk, "id": r["id"], "node_key": nk, "machine_key": nk,
                "machine": m["name"], "host": m["host"], "port": 0, "label": r["label"],
                "essence": r["essence"], "group": _sim_group(r), "master_enable": bool(snd),
                "multicast_ip": snd["mcast"] if snd else None, "source_ip": None,
                "dest_port": snd.get("port") if snd else None,
                "sender_id": sk if snd else None,
                "active_sender_key": sk if snd else None})
    annotate_groups(senders)          # repli heuristique pour les machines sans grouphint
    annotate_groups(receivers)
    return {"simulated": True, "machines": machines, "senders": senders,
            "receivers": receivers, "generated_at": time.time()}


def _sim_take(receiver_key, sender_key):
    m_r, r = _sim_receiver(receiver_key)
    m_s, s = _sim_sender(sender_key)
    if not r:
        raise NmosError("receiver simulé inconnu")
    if not s:
        raise NmosError("sender simulé inconnu")
    if r["essence"] != s["essence"]:
        raise NmosError(f"essences incompatibles ({r['essence']} ≠ {s['essence']})")
    routing = load_sim_routing()
    routing[receiver_key] = sender_key
    save_sim_routing(routing)


def _sim_disconnect(receiver_key):
    routing = load_sim_routing()
    if receiver_key in routing:
        routing.pop(receiver_key, None)
        save_sim_routing(routing)


# SDP simulé : transportfile synthétique pour exercer « voir / coller un SDP » sans matériel.
_SIM_MEDIA = {
    "audio": ("m=audio {port} RTP/AVP 97", "a=rtpmap:97 L24/48000/2"),
    "video": ("m=video {port} RTP/AVP 96", "a=rtpmap:96 raw/90000"),
    "data": ("m=video {port} RTP/AVP 100", "a=rtpmap:100 smpte291/90000"),
}


def _synth_sim_sdp(machine, s):
    """SDP synthétique d'un sender du parc simulé (le matériel réel publie un vrai transportfile)."""
    mip, port, src = s.get("mcast"), s.get("port", 5004), machine.get("host")
    media, rtpmap = _SIM_MEDIA.get(s.get("essence"), _SIM_MEDIA["video"])
    return "\n".join([
        "v=0", f"o=- 0 0 IN IP4 {src}", f"s={s.get('label')}", "t=0 0",
        media.format(port=port), f"c=IN IP4 {mip}/64",
        f"a=source-filter:incl IN IP4 {mip} {src}", rtpmap,
        "a=ts-refclk:ptp=IEEE1588-2008:traceable", "a=mediaclk:direct=0", ""])


def _sim_apply_sdp(receiver_key, sdp):
    """Colle un SDP en simulation : on route le receiver vers le sender démo dont le multicast
    correspond au SDP (le seul lien représentable dans le modèle simulé)."""
    _, r = _sim_receiver(receiver_key)
    if not r:
        raise NmosError("receiver simulé inconnu")
    want = {leg.get("multicast_ip") for leg in parse_sdp_legs(sdp)}
    for m in SIM_PARC:
        nk = f"sim:{m['id']}"
        for s in m["senders"]:
            if s.get("mcast") in want:
                routing = load_sim_routing()
                routing[receiver_key] = f"{nk}|{s['id']}"
                save_sim_routing(routing)
                return {"ok": True, "matched_sender": s["label"]}
    raise NmosError("en simulation, le SDP doit pointer le multicast d'un sender du parc démo")


# --------------------------------------------------------------------------- inventaire réel

def bmd_nodes():
    """Nodes NMOS déduits du parc bmd_nmos (lecture seule). Un node par cage SFP."""
    devices = _read(os.path.join(BMD_DIR, "devices.json"), [])
    models = _read(os.path.join(BMD_DIR, "models.json"), {}) or {}
    out = []
    for d in devices if isinstance(devices, list) else []:
        model = models.get(d.get("model")) or _BMD_DEFAULT
        base = int(d.get("base_port") or model.get("base_port") or 8090)
        step = int(model.get("step") or 2)
        count = int(model.get("count") or _BMD_DEFAULT["count"] or 4)
        for i in range(count):
            out.append({"node_key": f"bmd:{d.get('id')}:{i + 1}",
                        "machine_key": f"bmd:{d.get('id')}",
                        "machine": d.get("name") or d.get("host") or "?",
                        "host": d.get("host"), "port": base + step * i,
                        "source": "bmd", "sfp": i + 1})
    return out


def all_nodes():
    """Tous les nodes NMOS réels du parc : convertisseurs bmd_nmos + cibles manuelles."""
    nodes = bmd_nodes()
    for t in load_targets():
        nk = f"manual:{t.get('id')}"
        nodes.append({"node_key": nk, "machine_key": nk,
                      "machine": t.get("name") or f"{t.get('host')}:{t.get('port')}",
                      "host": t.get("host"), "port": int(t.get("port") or 80),
                      "source": "manual"})
    return nodes


def is_sim():
    """Simulation active tant qu'aucun node réel n'est déclaré (inventaire vide)."""
    return not bmd_nodes() and not load_targets()


# --------------------------------------------------------------------------- grille (état)

def _sender_legs(s):
    """Legs de destination d'un sender : liste de {dest_ip, dest_port, source_ip}. Repli sur les
    champs scalaires (parc simulé, ou node ne renvoyant qu'un leg)."""
    legs = s.get("legs")
    if legs:
        return legs
    return [{"dest_ip": s.get("dest_ip"), "dest_port": s.get("dest_port"),
             "source_ip": s.get("source_ip")}]


def _receiver_legs(r):
    """Legs d'abonnement d'un receiver : liste de {multicast_ip, dest_port, source_ip}."""
    legs = r.get("legs")
    if legs:
        return legs
    return [{"multicast_ip": r.get("multicast_ip"), "dest_port": r.get("dest_port"),
             "source_ip": r.get("source_ip")}]


def _match_active(senders, receivers, debug=False):
    """Renseigne receiver['active_sender_key'] : d'abord par sender_id (IS-05), sinon par
    corrélation multicast:port. La corrélation multicast teste TOUS les legs des deux extrémités
    (ST 2022-7 : les legs ne sont pas forcément ordonnés pareil des deux côtés) et retient la
    meilleure correspondance (source identique = SSM exact prioritaire). `debug` ajoute
    receiver['_match'] décrivant la voie retenue (diagnostic « pas de point »)."""
    by_id = {s["id"]: s for s in senders}
    for r in receivers:
        r["active_sender_key"] = None
        if debug:
            r["_match"] = {"master_enable": bool(r.get("master_enable")),
                           "sender_id": r.get("sender_id"), "via": None,
                           "recv_legs": _receiver_legs(r)}
        if not r.get("master_enable"):
            if debug:
                r["_match"]["via"] = "skip:master_enable=false"
            continue
        sid = r.get("sender_id")
        if sid and sid in by_id:
            r["active_sender_key"] = by_id[sid]["key"]
            if debug:
                r["_match"]["via"] = "sender_id"
            continue
        # Repli multicast : tout leg receiver dont le multicast_ip == un dest_ip de sender.
        best, best_exact = None, False
        for s in senders:
            # Un sender DÉSARMÉ n'émet rien, mais IS-05 /active continue de publier sa dernière
            # destination : sur beaucoup de châssis, les senders audio/ANC au repos annoncent tous
            # l'adresse du sender vidéo actif (vécu sur Bobi.Studio, cf. nmos_diag qui les écarte
            # pareillement). L'ancien code les acceptait comme candidats : le receiver se voyait
            # attribuer le PREMIER sender rencontré dans l'ordre d'annonce IS-04 — souvent un
            # audio au repos, qui partage jusqu'à la source_ip du châssis et passait donc même
            # pour une correspondance SSM « exacte ». Ce croisement fantôme est ensuite recopié
            # dans les snapshots/salvos (current_crosspoints → active_sender_key), et un rappel de
            # salvo poussait alors le SDP audio de ce sender sur une entrée vidéo. On ne corrèle
            # donc que des senders réellement en émission ; à défaut, pas de croisement affiché,
            # ce qui est la vérité (le receiver ne reçoit rien).
            if not s.get("master_enable"):
                continue
            slegs = _sender_legs(s)
            matched, exact = False, False
            for rl in _receiver_legs(r):
                mip = rl.get("multicast_ip")
                if not mip:
                    continue
                for sl in slegs:
                    if sl.get("dest_ip") != mip:
                        continue
                    rp, sp = rl.get("dest_port"), sl.get("dest_port")
                    if rp and sp and rp != sp:
                        continue
                    rsrc = rl.get("source_ip")
                    if rsrc and sl.get("source_ip") and rsrc != sl.get("source_ip"):
                        continue
                    matched = True
                    if rsrc and sl.get("source_ip") == rsrc:
                        exact = True
            if matched and (best is None or (exact and not best_exact)):
                best, best_exact = s, exact
                if exact:
                    break  # correspondance SSM exacte : on s'arrête
        if best:
            r["active_sender_key"] = best["key"]
            if debug:
                r["_match"]["via"] = "multicast" + (":ssm" if best_exact else "")
        elif debug and sid:
            r["_match"]["via"] = "sender_id-unknown"


def _build_grid_live(debug=False):
    nodes = all_nodes()
    machines, senders, receivers, unreachable = {}, [], [], []

    def one(n):
        try:
            return n, NmosNode(n["host"], n["port"]).snapshot()
        except NmosError as e:
            return n, {"error": str(e)}

    results = []
    if nodes:
        with ThreadPoolExecutor(max_workers=8) as ex:
            results = list(ex.map(one, nodes))
    for n, snap in results:
        mk = n["machine_key"]
        mac = machines.setdefault(mk, {"key": mk, "name": n["machine"],
                                       "source": n["source"], "reachable": False})
        if snap.get("error"):
            unreachable.append({"machine": n["machine"], "node_key": n["node_key"],
                                "host": n["host"], "port": n["port"], "error": snap["error"]})
            continue
        mac["reachable"] = True
        for s in snap.get("senders", []):
            senders.append({
                "key": f"{n['node_key']}|{s['id']}", "id": s["id"], "node_key": n["node_key"],
                "machine_key": mk, "machine": n["machine"], "host": n["host"], "port": n["port"],
                "label": s["label"], "essence": s.get("essence", ""), "group": s.get("group"),
                "master_enable": s.get("master_enable", False),
                "dest_ip": s.get("dest_ip"), "dest_port": s.get("dest_port"),
                "source_ip": s.get("source_ip"), "legs": s.get("legs")})
        for r in snap.get("receivers", []):
            receivers.append({
                "key": f"{n['node_key']}|{r['id']}", "id": r["id"], "node_key": n["node_key"],
                "machine_key": mk, "machine": n["machine"], "host": n["host"], "port": n["port"],
                "label": r["label"], "essence": r.get("essence", ""), "group": r.get("group"),
                "master_enable": r.get("master_enable", False),
                "sender_id": r.get("sender_id"), "multicast_ip": r.get("multicast_ip"),
                "source_ip": r.get("source_ip"), "dest_port": r.get("dest_port"),
                "legs": r.get("legs")})
    _match_active(senders, receivers, debug=debug)
    if not debug:                     # `legs` n'est utile qu'à la corrélation : hors debug on l'élague
        for x in senders:
            x.pop("legs", None)
        for x in receivers:
            x.pop("legs", None)
    annotate_groups(senders)          # repli heuristique pour les nodes sans grouphint
    annotate_groups(receivers)
    return {"simulated": False, "machines": list(machines.values()),
            "senders": senders, "receivers": receivers, "unreachable": unreachable,
            "generated_at": time.time()}


def build_grid(fresh=False, debug=False):
    if is_sim():
        return _sim_grid()  # cache inutile : lecture d'un simple fichier local
    if debug:
        return _build_grid_live(debug=True)  # jamais caché : diagnostic à la demande
    now = time.time()
    with _grid_lock:
        c = _grid_cache["data"]
        if c and not fresh and (now - _grid_cache["ts"]) < GRID_TTL:
            return c
    data = _build_grid_live()
    with _grid_lock:
        _grid_cache["data"] = data
        _grid_cache["ts"] = time.time()
    return data


def invalidate_grid():
    with _grid_lock:
        _grid_cache["data"] = None
        _grid_cache["ts"] = 0.0


# --------------------------------------------------------------------------- takes

def _split_key(key):
    node_key, _, rid = (key or "").rpartition("|")
    return node_key, rid


def take(receiver_key, sender_key):
    """Abonne un receiver à un sender (SDP du sender → PATCH staged du receiver, activation
    immédiate). ÉCRITURE : (re)route un flux 2110 réel."""
    if is_sim():
        return _sim_take(receiver_key, sender_key)
    nodes = {n["node_key"]: n for n in all_nodes()}
    rnk, rid = _split_key(receiver_key)
    snk, sid = _split_key(sender_key)
    rn, sn = nodes.get(rnk), nodes.get(snk)
    if not rn:
        raise NmosError("receiver introuvable dans le parc")
    if not sn:
        raise NmosError("sender introuvable dans le parc")
    sdp = NmosNode(sn["host"], sn["port"]).sender_sdp(sid)
    if not (sdp or "").strip():
        raise NmosError("le sender ne publie pas de transportfile (SDP)")
    NmosNode(rn["host"], rn["port"]).apply_sdp(rid, sdp, enable=True)


def disconnect(receiver_key):
    """Désabonne un receiver (master_enable=false)."""
    if is_sim():
        return _sim_disconnect(receiver_key)
    nodes = {n["node_key"]: n for n in all_nodes()}
    rnk, rid = _split_key(receiver_key)
    rn = nodes.get(rnk)
    if not rn:
        raise NmosError("receiver introuvable dans le parc")
    NmosNode(rn["host"], rn["port"]).disable_receiver(rid)


def sender_sdp_for(sender_key):
    """SDP (transportfile) publié par un sender, désigné par sa clé de grille. LECTURE seule."""
    if is_sim():
        m, s = _sim_sender(sender_key)
        if not s:
            raise NmosError("sender simulé inconnu")
        return _synth_sim_sdp(m, s)
    nodes = {n["node_key"]: n for n in all_nodes()}
    snk, sid = _split_key(sender_key)
    sn = nodes.get(snk)
    if not sn:
        raise NmosError("sender introuvable dans le parc")
    sdp = NmosNode(sn["host"], sn["port"]).sender_sdp(sid)
    if not (sdp or "").strip():
        raise NmosError("le sender ne publie pas de transportfile (SDP)")
    return sdp


def receiver_sdp_for(receiver_key):
    """SDP (transport_file) COURANT d'un receiver — ce à quoi il est abonné. LECTURE seule.
    Erreur claire si la destination ne porte aucun SDP (non abonnée)."""
    if is_sim():
        sk = load_sim_routing().get(receiver_key)
        m, s = _sim_sender(sk) if sk else (None, None)
        if not s:
            raise NmosError("destination non abonnée (aucun SDP chargé)")
        return _synth_sim_sdp(m, s)
    nodes = {n["node_key"]: n for n in all_nodes()}
    rnk, rid = _split_key(receiver_key)
    rn = nodes.get(rnk)
    if not rn:
        raise NmosError("receiver introuvable dans le parc")
    sdp = NmosNode(rn["host"], rn["port"]).receiver_sdp(rid)
    if not (sdp or "").strip():
        raise NmosError("la destination n'a pas de SDP chargé (non abonnée)")
    return sdp


def apply_sdp_to_receiver(receiver_key, sdp):
    """Colle un SDP ARBITRAIRE sur un receiver (PATCH staged + activation immédiate). ÉCRITURE :
    abonne l'équipement au flux décrit par le SDP fourni, hors grille des senders connus."""
    if not (sdp or "").strip():
        raise NmosError("SDP vide")
    if not parse_sdp_legs(sdp):
        raise NmosError("SDP invalide : aucune ligne m=/c= avec multicast exploitable")
    if is_sim():
        return _sim_apply_sdp(receiver_key, sdp)
    nodes = {n["node_key"]: n for n in all_nodes()}
    rnk, rid = _split_key(receiver_key)
    rn = nodes.get(rnk)
    if not rn:
        raise NmosError("receiver introuvable dans le parc")
    NmosNode(rn["host"], rn["port"]).apply_sdp(rid, sdp, enable=True)
    return {"ok": True}


BOUNCE_DELAY = 1.5  # s entre désarmement et réarmement d'un sender (laisse l'équipement relâcher)


def bounce_sender(sender_key):
    """« Bounce » d'un sender : master_enable false → (pause) → true, activation immédiate.
    Force un équipement à réarmer son émission 2110. Utile quand un convertisseur garde son
    sender « enabled » mais n'émet plus rien après un changement de source. ÉCRITURE : agit sur
    du matériel réel. N.B. NE recrée PAS une émission absente pour cause d'entrée : si le sender
    n'émet pas parce que l'entrée SDI n'a pas de signal (ou un format non reconnu), le bounce n'y
    change rien — il ne débloque qu'un sender réellement coincé côté protocole."""
    if is_sim():
        return {"ok": True, "simulated": True}
    nodes = {n["node_key"]: n for n in all_nodes()}
    snk, sid = _split_key(sender_key)
    sn = nodes.get(snk)
    if not sn:
        raise NmosError("sender introuvable dans le parc")
    node = NmosNode(sn["host"], sn["port"])
    node.set_sender_enable(sid, False)
    time.sleep(BOUNCE_DELAY)
    node.set_sender_enable(sid, True)
    return {"ok": True}


def set_senders_enable(sender_keys, enable):
    """Active/désactive l'émission (IS-05 master_enable) d'une liste de senders, activation
    immédiate. Rapport par sender ; une entrée fautive n'interrompt pas le lot."""
    keys = list(sender_keys or [])
    if is_sim():
        res = [{"sender_key": sk, "status": "ok", "ok": True, "error": None} for sk in keys]
        return {"results": res, "ok_count": len(res), "fail_count": 0, "simulated": True}
    nodes = {n["node_key"]: n for n in all_nodes()}
    out = []
    for sk in keys:
        entry = {"sender_key": sk, "status": "ok", "ok": True, "error": None}
        snk, sid = _split_key(sk)
        sn = nodes.get(snk)
        if not sn:
            entry.update(status="fail", ok=False, error="sender introuvable dans le parc")
        else:
            try:
                NmosNode(sn["host"], sn["port"]).set_sender_enable(sid, bool(enable))
            except Exception as e:  # noqa: BLE001
                entry.update(status="fail", ok=False, error=str(e))
        out.append(entry)
    invalidate_grid()
    return {"results": out,
            "ok_count": sum(1 for r in out if r["ok"]),
            "fail_count": sum(1 for r in out if not r["ok"])}


def bounce_senders(sender_keys):
    """Relance GROUPÉE (ex-« bounce ») d'une liste de senders. Désarme TOUS les senders, une SEULE pause, puis les
    réarme tous — ils retombent et reviennent ensemble. Bien plus rapide qu'un bounce unitaire
    répété (une seule pause au lieu de N) → évite une requête interminable sur un gros lot.
    Rapport par sender ; une entrée fautive n'interrompt pas le lot."""
    keys = list(sender_keys or [])
    if is_sim():
        res = [{"sender_key": sk, "status": "ok", "ok": True, "error": None} for sk in keys]
        return {"results": res, "ok_count": len(res), "fail_count": 0, "simulated": True}
    nodes = {n["node_key"]: n for n in all_nodes()}
    results = {sk: {"sender_key": sk, "status": "ok", "ok": True, "error": None} for sk in keys}
    items = []
    for sk in keys:
        snk, sid = _split_key(sk)
        sn = nodes.get(snk)
        if not sn:
            results[sk].update(status="fail", ok=False, error="sender introuvable dans le parc")
            continue
        items.append((sk, NmosNode(sn["host"], sn["port"]), sid))
    for sk, node, sid in items:                       # phase 1 : désarmer
        try:
            node.set_sender_enable(sid, False)
        except Exception as e:  # noqa: BLE001 — un sender fautif n'arrête pas le lot
            results[sk].update(status="fail", ok=False, error="désarmement : " + str(e))
    time.sleep(BOUNCE_DELAY)
    for sk, node, sid in items:                       # phase 2 : réarmer (si désarmement OK)
        if not results[sk]["ok"]:
            continue
        try:
            node.set_sender_enable(sid, True)
        except Exception as e:  # noqa: BLE001
            results[sk].update(status="fail", ok=False, error="réarmement : " + str(e))
    invalidate_grid()
    out = [results[sk] for sk in keys]
    return {"results": out,
            "ok_count": sum(1 for r in out if r["ok"]),
            "fail_count": sum(1 for r in out if not r["ok"])}


def apply_crosspoints(cps):
    """Applique une liste de croisements {receiver_key, sender_key?}. sender_key absent/None =
    déconnexion. Renvoie un rapport par croisement (jamais d'exception qui interrompt le lot)."""
    results = []
    for cp in cps or []:
        rk, sk = cp.get("receiver_key"), cp.get("sender_key")
        entry = {"receiver_key": rk, "sender_key": sk,
                 "receiver_label": cp.get("receiver_label"), "sender_label": cp.get("sender_label")}
        try:
            if sk:
                take(rk, sk)
            else:
                disconnect(rk)
            entry.update(ok=True, error=None)
        except Exception as e:  # noqa: BLE001 — un croisement fautif ne doit pas stopper le salvo
            entry.update(ok=False, error=str(e))
        results.append(entry)
    invalidate_grid()
    return {"results": results,
            "ok_count": sum(1 for r in results if r["ok"]),
            "fail_count": sum(1 for r in results if not r["ok"])}


def current_crosspoints(active_only):
    """Croisements courants du parc. active_only=True → seulement les receivers abonnés (salvo) ;
    False → tous les receivers avec leur source (ou None si déconnecté) pour un snapshot complet."""
    g = build_grid(fresh=True)
    smap = {s["key"]: s for s in g["senders"]}
    out = []
    for r in g["receivers"]:
        sk = r.get("active_sender_key")
        if active_only and not sk:
            continue
        snd = smap.get(sk)
        out.append({
            "receiver_key": r["key"], "sender_key": sk,
            "receiver_label": f"{r['label']} · {r['machine']}",
            "sender_label": (f"{snd['label']} · {snd['machine']}" if snd else None)})
    return out


# --------------------------------------------------------------------------- takes groupés

def _report_counts(results):
    return {"ok_count": sum(1 for x in results if x["status"] == "ok"),
            "fail_count": sum(1 for x in results if x["status"] == "fail"),
            "nomatch_count": sum(1 for x in results if x["status"] == "no_match")}


def take_group(receiver_group, sender_group):
    """Take GROUPÉ : apparie les essences des deux groupes et applique les takes un par un.
    Rapport par paire — status ok / fail (take en erreur) / no_match (receiver sans sender).
    Les receivers du groupe sans correspondance côté sender restent inchangés."""
    g = build_grid(fresh=True)
    recvs = _resolve_group(g, "r", receiver_group)
    sends = _resolve_group(g, "s", sender_group)
    pairs, unmatched = _pair_group(recvs, sends)
    results = []
    for r, s, ess in pairs:
        entry = {"essence": ess, "status": "ok", "ok": True, "error": None,
                 "receiver_key": r["key"], "sender_key": s["key"],
                 "receiver_label": f"{r['label']} · {r['machine']}",
                 "sender_label": f"{s['label']} · {s['machine']}"}
        try:
            take(r["key"], s["key"])
        except Exception as e:  # noqa: BLE001 — une paire fautive n'interrompt pas le lot
            entry.update(status="fail", ok=False, error=str(e))
        results.append(entry)
    for r in unmatched:
        results.append({"essence": r.get("essence"), "status": "no_match", "ok": False,
                        "error": None, "receiver_key": r["key"], "sender_key": None,
                        "receiver_label": f"{r['label']} · {r['machine']}", "sender_label": None})
    invalidate_grid()
    out = {"results": results}
    out.update(_report_counts(results))
    return out


def disconnect_group(receiver_group):
    """Déconnexion GROUPÉE : désabonne chaque receiver du groupe. Rapport par receiver."""
    g = build_grid(fresh=True)
    recvs = _resolve_group(g, "r", receiver_group)
    results = []
    for r in recvs:
        entry = {"essence": r.get("essence"), "status": "ok", "ok": True, "error": None,
                 "receiver_key": r["key"], "sender_key": None,
                 "receiver_label": f"{r['label']} · {r['machine']}", "sender_label": None}
        try:
            disconnect(r["key"])
        except Exception as e:  # noqa: BLE001
            entry.update(status="fail", ok=False, error=str(e))
        results.append(entry)
    invalidate_grid()
    out = {"results": results}
    out.update(_report_counts(results))
    return out


# --------------------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            return {}

    def _qs(self):
        return {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}

    # -- GET --------------------------------------------------------------------

    def do_GET(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        q = self._qs()
        try:
            if parts == ["health"]:
                return self._send(200, {"ok": True})
            if parts == ["grid"]:
                debug = q.get("debug") in ("1", "true")
                return self._send(200, build_grid(fresh=q.get("fresh") in ("1", "true") or debug,
                                                  debug=debug))
            if parts == ["nodes"]:
                return self._send(200, {"nodes": all_nodes(), "simulated": is_sim()})
            if parts == ["sender-sdp"]:
                sk = q.get("sender_key")
                if not sk:
                    return self._send(400, {"error": "sender_key requis"})
                try:
                    return self._send(200, {"sdp": sender_sdp_for(sk)})
                except NmosError as e:
                    return self._send(502, {"error": str(e)})
            if parts == ["receiver-sdp"]:
                rk = q.get("receiver_key")
                if not rk:
                    return self._send(400, {"error": "receiver_key requis"})
                try:
                    return self._send(200, {"sdp": receiver_sdp_for(rk)})
                except NmosError as e:
                    return self._send(502, {"error": str(e)})
            if parts == ["salvos"]:
                return self._send(200, {"salvos": load_salvos()})
            if parts == ["snapshots"]:
                return self._send(200, {"snapshots": load_snapshots()})
            return self._send(404, {"error": "route inconnue"})
        except Exception as e:  # noqa: BLE001 — dernier rempart
            return self._send(500, {"error": str(e)})

    # -- POST -------------------------------------------------------------------

    def do_POST(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        body = self._body()
        try:
            if parts == ["nodes"]:
                host = (body.get("host") or "").strip()
                if not host or not body.get("port"):
                    return self._send(400, {"error": "host et port requis"})
                targets = load_targets()
                targets.append({"id": uuid.uuid4().hex[:8], "name": body.get("name") or "",
                                "host": host, "port": int(body["port"])})
                save_targets(targets)
                invalidate_grid()
                return self._send(201, {"ok": True})
            if parts == ["take"]:
                rk, sk = body.get("receiver_key"), body.get("sender_key")
                if not rk or not sk:
                    return self._send(400, {"error": "receiver_key et sender_key requis"})
                try:
                    take(rk, sk)
                except NmosError as e:
                    return self._send(502, {"error": str(e)})
                invalidate_grid()
                return self._send(200, {"ok": True})
            if parts == ["apply-sdp"]:
                rk, sdp = body.get("receiver_key"), body.get("sdp")
                if not rk or not (sdp or "").strip():
                    return self._send(400, {"error": "receiver_key et sdp requis"})
                try:
                    res = apply_sdp_to_receiver(rk, sdp)
                except NmosError as e:
                    return self._send(502, {"error": str(e)})
                invalidate_grid()
                return self._send(200, res)
            if parts == ["take-group"]:
                rg, sg = body.get("receiver_group"), body.get("sender_group")
                if not rg or not sg:
                    return self._send(400, {"error": "receiver_group et sender_group requis"})
                return self._send(200, take_group(rg, sg))
            if parts == ["disconnect-group"]:
                rg = body.get("receiver_group")
                if not rg:
                    return self._send(400, {"error": "receiver_group requis"})
                return self._send(200, disconnect_group(rg))
            if parts == ["disconnect"]:
                rk = body.get("receiver_key")
                if not rk:
                    return self._send(400, {"error": "receiver_key requis"})
                try:
                    disconnect(rk)
                except NmosError as e:
                    return self._send(502, {"error": str(e)})
                invalidate_grid()
                return self._send(200, {"ok": True})
            if parts == ["bounce"]:
                sk = body.get("sender_key")
                if not sk:
                    return self._send(400, {"error": "sender_key requis"})
                try:
                    res = bounce_sender(sk)
                except NmosError as e:
                    return self._send(502, {"error": str(e)})
                invalidate_grid()
                return self._send(200, res)
            if parts == ["bounce-group"]:
                sks = body.get("sender_keys")
                if not isinstance(sks, list) or not sks:
                    return self._send(400, {"error": "sender_keys (liste non vide) requis"})
                return self._send(200, bounce_senders(sks))
            if parts == ["sender-enable"]:
                sks = body.get("sender_keys")
                if not isinstance(sks, list) or not sks or "enable" not in body:
                    return self._send(400, {"error": "sender_keys (liste) et enable (bool) requis"})
                return self._send(200, set_senders_enable(sks, bool(body.get("enable"))))
            if parts == ["salvos"]:
                return self._salvo_create(body)
            if len(parts) == 3 and parts[0] == "salvos" and parts[2] == "apply":
                return self._salvo_apply(parts[1])
            if parts == ["snapshots"]:
                return self._snapshot_create(body)
            if len(parts) == 3 and parts[0] == "snapshots" and parts[2] == "apply":
                return self._snapshot_apply(parts[1])
            return self._send(404, {"error": "route inconnue"})
        except Exception as e:  # noqa: BLE001
            return self._send(500, {"error": str(e)})

    # -- PUT / DELETE -----------------------------------------------------------

    def do_PUT(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        body = self._body()
        try:
            if len(parts) == 2 and parts[0] == "salvos":
                return self._salvo_update(parts[1], body)
            return self._send(404, {"error": "route inconnue"})
        except Exception as e:  # noqa: BLE001
            return self._send(500, {"error": str(e)})

    def do_DELETE(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        try:
            if len(parts) == 2 and parts[0] == "nodes":
                save_targets([t for t in load_targets() if t.get("id") != parts[1]])
                invalidate_grid()
                return self._send(200, {"ok": True})
            if len(parts) == 2 and parts[0] == "salvos":
                save_salvos([s for s in load_salvos() if s.get("id") != parts[1]])
                return self._send(200, {"ok": True})
            if len(parts) == 2 and parts[0] == "snapshots":
                save_snapshots([s for s in load_snapshots() if s.get("id") != parts[1]])
                return self._send(200, {"ok": True})
            return self._send(404, {"error": "route inconnue"})
        except Exception as e:  # noqa: BLE001
            return self._send(500, {"error": str(e)})

    # -- salvos -----------------------------------------------------------------

    def _salvo_create(self, body):
        name = (body.get("name") or "").strip()
        if not name:
            return self._send(400, {"error": "nom requis"})
        cps = body.get("crosspoints")
        if cps is None:                       # capture du routage courant (sélection courante)
            cps = current_crosspoints(active_only=True)
        salvos = load_salvos()
        salvo = {"id": uuid.uuid4().hex[:8], "name": name,
                 "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                 "crosspoints": cps}
        salvos.append(salvo)
        save_salvos(salvos)
        return self._send(201, {"ok": True, "salvo": salvo})

    def _salvo_update(self, sid, body):
        salvos = load_salvos()
        s = next((x for x in salvos if x.get("id") == sid), None)
        if not s:
            return self._send(404, {"error": "salvo inconnu"})
        if "name" in body:
            s["name"] = (body.get("name") or s["name"]).strip()
        if "crosspoints" in body:
            s["crosspoints"] = body.get("crosspoints") or []
        elif body.get("from_current"):        # « mettre à jour depuis le routage courant »
            s["crosspoints"] = current_crosspoints(active_only=True)
        save_salvos(salvos)
        return self._send(200, {"ok": True, "salvo": s})

    def _salvo_apply(self, sid):
        s = next((x for x in load_salvos() if x.get("id") == sid), None)
        if not s:
            return self._send(404, {"error": "salvo inconnu"})
        return self._send(200, apply_crosspoints(s.get("crosspoints") or []))

    # -- snapshots --------------------------------------------------------------

    def _snapshot_create(self, body):
        name = (body.get("name") or "").strip()
        if not name:
            return self._send(400, {"error": "nom requis"})
        cps = current_crosspoints(active_only=False)   # photo complète (déconnexions comprises)
        snaps = load_snapshots()
        snap = {"id": uuid.uuid4().hex[:8], "name": name,
                "taken_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                "crosspoints": cps,
                "active_count": sum(1 for c in cps if c.get("sender_key"))}
        snaps.append(snap)
        save_snapshots(snaps)
        return self._send(201, {"ok": True, "snapshot": snap})

    def _snapshot_apply(self, sid):
        s = next((x for x in load_snapshots() if x.get("id") == sid), None)
        if not s:
            return self._send(404, {"error": "snapshot inconnu"})
        return self._send(200, apply_crosspoints(s.get("crosspoints") or []))


def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    port = int(os.environ.get("PORT", "8080"))
    print(f"nmos_grid : écoute sur :{port} (data={DATA_DIR}, bmd={BMD_DIR}, "
          f"simulation={is_sim()})", flush=True)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
