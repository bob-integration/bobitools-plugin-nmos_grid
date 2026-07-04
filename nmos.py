# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 BOBI SAS, France
# Auteur : Cyril Mazouer, pour le compte de BOBI SAS
# Distribué sous licence GNU GPL v3 (ou ultérieure) ; voir le fichier LICENSE.

"""Client NMOS générique — IS-04 (Node API) + IS-05 (Connection API).

Cousin du client de nmos_diag, orienté ROUTAGE : on énumère les senders (colonnes de la
grille) et les receivers (lignes), et surtout on lit l'ÉTAT COURANT d'abonnement de chaque
receiver (IS-05 /single/receivers/<id>/active) pour savoir à quel sender il est raccordé.

Méthodes clés :
  - snapshot()          : label + senders (essence, destination, group BCP-002-01) + receivers
                          (état d'abonnement + group, y compris sender_id / multicast lus dans
                          /active). `group` = natural grouping lu dans le tag IS-04
                          `urn:x-nmos:tag:grouphint/v1.0` → {name, role, inferred:false}.
  - sender_sdp()        : transportfile (SDP) publié par un sender
  - apply_sdp()         : PATCH staged d'un receiver (transport_file SDP + activation immédiate)
  - disable_receiver()  : master_enable=false

Marche avec tout node NMOS sans auth (convertisseurs Blackmagic, Bobi.Studio, easy-nmos…).
"""
try:
    import requests
except ImportError:
    requests = None

NODE_VERS = ("v1.3", "v1.2", "v1.1", "v1.0")
CONN_VERS = ("v1.1", "v1.0")
HTTP_TIMEOUT = 6


class NmosError(Exception):
    pass


def _fmt_short(fmt):
    """urn:x-nmos:format:video → 'video'. '' si inconnu."""
    if not fmt:
        return ""
    return str(fmt).rsplit(":", 1)[-1]


GROUPHINT_TAG = "urn:x-nmos:tag:grouphint/v1.0"


def _grouphint(res):
    """Extrait le « natural grouping » BCP-002-01 d'une ressource IS-04 (champ tags).

    Tag `urn:x-nmos:tag:grouphint/v1.0` = liste de chaînes « <nom du groupe>:<rôle dans le
    groupe> » (ex. « SDI 1:VIDEO »). On coupe sur le DERNIER « : » (le nom peut contenir des
    espaces ; par convention pas de « : »). Renvoie {name, role, inferred:false} ou None."""
    tags = res.get("tags") or {}
    vals = tags.get(GROUPHINT_TAG)
    if isinstance(vals, str):
        vals = [vals]
    if not isinstance(vals, list) or not vals:
        return None
    raw = str(vals[0]).strip()
    if not raw:
        return None
    name, sep, role = raw.rpartition(":")
    if not sep:                      # pas de « : » → tout est le nom, rôle vide
        name, role = raw, ""
    name = name.strip()
    if not name:
        return None
    return {"name": name, "role": role.strip().upper(), "inferred": False}


class NmosNode:
    """Un node NMOS = host + port (chez Blackmagic : un node par cage SFP)."""

    def __init__(self, host, port, timeout=HTTP_TIMEOUT):
        self.host = (host or "").strip()
        self.port = int(port)
        self.timeout = timeout
        self.base = f"http://{self.host}:{self.port}/x-nmos"
        self._node_ver = None
        self._conn_ver = None

    # -- HTTP bas niveau ------------------------------------------------------

    def _req(self, method, path, json_body=None, raw=False):
        if requests is None:
            raise NmosError("module 'requests' absent dans l'image")
        url = f"{self.base}/{path.lstrip('/')}"
        try:
            r = requests.request(method, url, json=json_body, timeout=self.timeout)
        except requests.RequestException as e:
            raise NmosError(f"{method} {path} : {e}")
        if r.status_code >= 400:
            raise NmosError(f"{method} {path} → HTTP {r.status_code} : {(r.text or '')[:300]}")
        if raw:
            return r.text
        try:
            return r.json()
        except ValueError:
            return None

    def _pick_ver(self, family, preferred):
        try:
            avail = self._req("GET", f"{family}/")
        except NmosError:
            avail = None
        got = {str(v).strip("/ ") for v in avail} if isinstance(avail, list) else set()
        for v in preferred:
            if v in got:
                return v
        return preferred[0]

    def node_ver(self):
        if self._node_ver is None:
            self._node_ver = self._pick_ver("node", NODE_VERS)
        return self._node_ver

    def conn_ver(self):
        if self._conn_ver is None:
            self._conn_ver = self._pick_ver("connection", CONN_VERS)
        return self._conn_ver

    # -- IS-04 ------------------------------------------------------------------

    def self_info(self):
        d = self._req("GET", f"node/{self.node_ver()}/self")
        return d if isinstance(d, dict) else {}

    def _list(self, kind):
        d = self._req("GET", f"node/{self.node_ver()}/{kind}")
        return d if isinstance(d, list) else []

    def reachable(self):
        try:
            self.self_info()
            return True
        except NmosError:
            return False

    # -- IS-05 : senders ----------------------------------------------------------

    def sender_active(self, sid):
        d = self._req("GET", f"connection/{self.conn_ver()}/single/senders/{sid}/active") or {}
        tp = (d.get("transport_params") or [{}])[0]
        return {"master_enable": bool(d.get("master_enable")),
                "dest_ip": tp.get("destination_ip"), "dest_port": tp.get("destination_port"),
                "source_ip": tp.get("source_ip")}

    def sender_sdp(self, sid):
        """Le transportfile (SDP) publié par un sender. Texte brut."""
        return self._req("GET", f"connection/{self.conn_ver()}/single/senders/{sid}/transportfile",
                         raw=True)

    # -- IS-05 : receivers ---------------------------------------------------------

    def receiver_active(self, rid):
        """État courant d'abonnement d'un receiver. `sender_id` (quand exposé par le node) et
        `multicast_ip`:port sont les DEUX voies de corrélation vers le sender abonné."""
        d = self._req("GET", f"connection/{self.conn_ver()}/single/receivers/{rid}/active") or {}
        tp = (d.get("transport_params") or [{}])[0]
        tf = d.get("transport_file") or {}
        return {"master_enable": bool(d.get("master_enable")),
                "sender_id": d.get("sender_id"),
                "multicast_ip": tp.get("multicast_ip"), "source_ip": tp.get("source_ip"),
                "dest_port": tp.get("destination_port"), "interface_ip": tp.get("interface_ip"),
                "has_sdp": bool(tf.get("data"))}

    def apply_sdp(self, rid, sdp, enable=True):
        """PATCH staged du receiver avec le SDP fourni + activation immédiate.
        ÉCRITURE : abonne un équipement réel à un flux. Renvoie le staged résultant."""
        body = {"master_enable": bool(enable), "sender_id": None,
                "activation": {"mode": "activate_immediate"},
                "transport_file": {"type": "application/sdp", "data": sdp}}
        return self._req("PATCH",
                         f"connection/{self.conn_ver()}/single/receivers/{rid}/staged", body)

    def disable_receiver(self, rid):
        """Désabonne un receiver (master_enable=false, activation immédiate)."""
        body = {"master_enable": False, "sender_id": None,
                "activation": {"mode": "activate_immediate"},
                "transport_file": {"type": None, "data": None}}
        return self._req("PATCH",
                         f"connection/{self.conn_ver()}/single/receivers/{rid}/staged", body)

    # -- Agrégat pour la grille -----------------------------------------------------

    def snapshot(self):
        """Label + senders (essence + destination + état) + receivers (état d'abonnement)."""
        info = self.self_info()
        flows = {f.get("id"): _fmt_short(f.get("format")) for f in self._list("flows")}
        senders = []
        for s in self._list("senders"):
            sid = s.get("id")
            try:
                act = self.sender_active(sid)
            except NmosError:
                act = {}
            senders.append({"id": sid, "label": s.get("label") or sid,
                            "essence": flows.get(s.get("flow_id"), ""),
                            "group": _grouphint(s),
                            "master_enable": act.get("master_enable", False),
                            "dest_ip": act.get("dest_ip"), "dest_port": act.get("dest_port"),
                            "source_ip": act.get("source_ip")})
        receivers = []
        for r in self._list("receivers"):
            rid = r.get("id")
            try:
                act = self.receiver_active(rid)
            except NmosError:
                act = {}
            receivers.append({"id": rid, "label": r.get("label") or rid,
                              "essence": _fmt_short(r.get("format")),
                              "group": _grouphint(r),
                              "master_enable": act.get("master_enable", False),
                              "sender_id": act.get("sender_id"),
                              "multicast_ip": act.get("multicast_ip"),
                              "source_ip": act.get("source_ip"),
                              "dest_port": act.get("dest_port"),
                              "has_sdp": act.get("has_sdp", False)})
        return {"label": info.get("label") or "", "senders": senders, "receivers": receivers}
