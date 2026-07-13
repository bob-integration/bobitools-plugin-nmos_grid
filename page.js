// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 BOBI SAS, France
// Auteur : Cyril Mazouer, pour le compte de BOBI SAS
// Distribué sous licence GNU GPL v3 (ou ultérieure) ; voir le fichier LICENSE.

// UI de « Grille NMOS ». Front pur : toute la logique tourne dans le conteneur, atteinte via
// ctx.api(...). Le RENDU de la matrice est délégué au composant partagé window.BT.Grid
// (static/js/bt-grid.js) : convention Bobi.Tools = SOURCES (senders) en LIGNES, DESTINATIONS
// (receivers) en COLONNES. Ici on ne fait que : charger le parc, filtrer, construire les axes
// selon la vue (« par flux » = 1 sender/receiver par ligne ; « par signal » = groupe V/A/ANC),
// et brancher les callbacks métier (route/déconnexion/actions IS-05). Le repli/épingle/scroll,
// la barre TAKE et la sélection de sources sont fournis par BT.Grid.
window.BTTools = window.BTTools || {};
window.BTTools.nmos_grid = (function () {
    "use strict";
    let ctx = null, root = null;
    let grid = { senders: [], receivers: [], machines: [], simulated: false };
    let filters = { essence: "", machine: "" };
    let search = "";                    // recherche libre (NON persistée)
    let view = "flux";                  // "flux" | "signal"
    let wiredOnly = false;              // masque les destinations sans croisement actif
    let directTake = false;             // TAKE direct : clic = route immédiate (BT.Grid : sans barre TAKE)
    let pollTimer = null;
    let btGrid = null;                  // instance BT.Grid (mount une fois, setData ensuite)
    let sdpEsc = null;                  // handler Échap de la modale SDP (retiré à la fermeture)

    const esc = (s) => (window.BT && BT.esc ? BT.esc(s) : String(s == null ? "" : s));
    const tr = (key, fb) => { const v = ctx && ctx.t ? ctx.t(key) : null; return (v && v !== key) ? v : fb; };
    const $ = (sel) => root.querySelector(sel);
    const toast = (m, k) => ctx.toast(m, k);
    const uniq = (a) => [...new Set(a)];
    const POLL_MS = 7000;
    const ESS_ORDER = { video: 0, audio: 1, data: 2 };
    const ESS_CHIP = { video: "V", audio: "A", data: "ANC" };

    // Normalisation pour la recherche : minuscules + suppression des accents.
    const norm = (s) => (s == null ? "" : String(s)).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

    // ── Persistance des préférences (localStorage, clé préfixée par le type) ──
    // NB : repli/épingle sont désormais persistés par BT.Grid (persistKey ci-dessous).
    const PREF_KEY = () => "bt:" + (ctx && ctx.type ? ctx.type : "nmos_grid") + ":prefs";
    const GRID_KEY = () => "bt:" + (ctx && ctx.type ? ctx.type : "nmos_grid") + ":grid";
    function loadPrefs() {
        let p = {};
        try { p = JSON.parse(window.localStorage.getItem(PREF_KEY()) || "{}") || {}; } catch (e) { p = {}; }
        if (p.view === "signal" || p.view === "flux") view = p.view;
        filters.essence = p.essence || ""; filters.machine = p.machine || "";
        wiredOnly = !!p.wiredOnly;
        directTake = !!p.directTake;
    }
    function savePrefs() {
        try {
            window.localStorage.setItem(PREF_KEY(), JSON.stringify({
                view, essence: filters.essence, machine: filters.machine, wiredOnly, directTake
            }));
        } catch (e) { /* quota / mode privé : on ignore */ }
    }

    // ── Cycle de vie ─────────────────────────────────────────
    function mount(el, context) {
        ctx = context; root = el;
        loadPrefs();
        applyI18n();
        $("#ng-f-view").value = view;
        $("#ng-f-essence").value = filters.essence;
        $("#ng-f-wired").checked = wiredOnly;
        $("#ng-f-direct").checked = directTake;
        $("#ng-refresh").addEventListener("click", () => refresh(true));
        $("#ng-add").addEventListener("click", () => { $("#ng-form").hidden = false; renderManual(); });
        $("#ng-f-cancel").addEventListener("click", () => { $("#ng-form").hidden = true; });
        $("#ng-form").addEventListener("submit", onAddNode);
        $("#ng-search").addEventListener("input", (e) => { search = e.target.value || ""; renderGrid(); });
        $("#ng-f-view").addEventListener("change", (e) => { view = e.target.value; savePrefs(); renderGrid(); });
        $("#ng-f-essence").addEventListener("change", (e) => { filters.essence = e.target.value; savePrefs(); renderGrid(); });
        $("#ng-f-machine").addEventListener("change", (e) => { filters.machine = e.target.value; savePrefs(); renderGrid(); });
        $("#ng-f-wired").addEventListener("change", (e) => { wiredOnly = e.target.checked; savePrefs(); renderGrid(); });
        // directTake pilote features.takeBar (figé au mount BT.Grid) → on remonte la grille
        $("#ng-f-direct").addEventListener("change", (e) => { directTake = e.target.checked; savePrefs(); renderGrid(true); });
        $("#ng-sdp-view").addEventListener("click", () => {
            const sel = $("#ng-sdp-src");
            viewSenderSdp(sel.value, sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : "");
        });
        $("#ng-sdp-apply").addEventListener("click", pasteSdp);
        $("#ng-salvo-new").addEventListener("click", newSalvo);
        $("#ng-snap-new").addEventListener("click", newSnapshot);
        refresh(true);
        loadSalvos();
        loadSnapshots();
        pollTimer = setInterval(() => refresh(false), POLL_MS);
    }

    function unmount() {
        if (pollTimer) clearInterval(pollTimer);
        closeSdpModal();
        if (btGrid) { try { btGrid.destroy(); } catch (e) { /* ignore */ } btGrid = null; }
        ctx = root = null;
        grid = { senders: [], receivers: [], machines: [], simulated: false };
    }

    function applyI18n() {
        if (!ctx.t) return;
        root.querySelectorAll("[data-i18n]").forEach((el) => {
            const v = ctx.t(el.getAttribute("data-i18n"));
            if (v && v !== el.getAttribute("data-i18n")) el.textContent = v;
        });
        root.querySelectorAll("[data-i18n-ph]").forEach((el) => {
            const v = ctx.t(el.getAttribute("data-i18n-ph"));
            if (v && v !== el.getAttribute("data-i18n-ph")) el.setAttribute("placeholder", v);
        });
    }

    // ── Chargement du parc ───────────────────────────────────
    async function refresh(fresh) {
        let d;
        try { d = await ctx.api("grid" + (fresh ? "?fresh=1" : "")); }
        catch (e) { if (fresh) toast(e.message, "error"); return; }
        if (!root) return;
        grid = d || grid;
        $("#ng-sim").hidden = !grid.simulated;
        $("#ng-sim-hint").hidden = !grid.simulated;
        renderMachineFilter();
        renderSdpSelectors();
        renderGrid();
    }

    function renderMachineFilter() {
        const sel = $("#ng-f-machine");
        const cur = filters.machine;
        sel.innerHTML = `<option value="">${esc(tr("plugin.nmos_grid.all", "Toutes"))}</option>` +
            (grid.machines || []).map((m) => `<option value="${esc(m.key)}">${esc(m.name)}</option>`).join("");
        sel.value = cur;
        if (sel.value !== cur) filters.machine = "";
    }

    // ── Filtres de base (essence / machine / recherche) ──────
    function essenceOk(x) { return !filters.essence || (x.essence || "") === filters.essence; }
    function machineOk(x) { return !filters.machine || x.machine_key === filters.machine; }
    function searchOk(x) {
        if (!search) return true;
        const q = norm(search);
        const gn = x.group && x.group.name ? x.group.name : "";
        return norm(x.label).indexOf(q) >= 0 || norm(gn).indexOf(q) >= 0 || norm(x.machine).indexOf(q) >= 0;
    }
    function itemVisible(x) { return essenceOk(x) && machineOk(x) && searchOk(x); }

    // ── Descripteurs selon la vue (flux = 1 item ; signal = groupe BCP-002-01) ──
    // Descripteur : { kind, members[], label, machine_key, essences[], groupName?, inferred? }
    function descsFor(items, side) {
        if (view === "flux") {
            return items.map((it) => ({
                kind: side, members: [it], label: it.label, machine_key: it.machine_key,
                essences: it.essence ? [it.essence] : [], group: it.group || null
            }));
        }
        const out = [], byGroup = new Map();
        items.forEach((it) => {
            const gn = it.group && it.group.name;
            if (!gn) {                          // signal orphelin : affiché seul
                out.push({ kind: side, members: [it], label: it.label, machine_key: it.machine_key,
                    essences: it.essence ? [it.essence] : [], group: null });
                return;
            }
            if (!byGroup.has(gn)) {
                const d = { kind: "group", members: [], label: gn, machine_key: it.machine_key,
                    essences: [], groupName: gn, inferred: !!(it.group && it.group.inferred) };
                byGroup.set(gn, d); out.push(d);
            }
            const d = byGroup.get(gn);
            d.members.push(it);
            if (it.essence && d.essences.indexOf(it.essence) < 0) d.essences.push(it.essence);
        });
        return out;
    }

    // ── Appariement des essences (identique au serveur) ──────
    function roleKey(x) { const g = x.group || {}; return (g.role || "") + " " + (x.label || ""); }
    function pairMembers(recvs, sends) {
        const br = {}, bs = {};
        recvs.forEach((r) => { (br[r.essence || ""] = br[r.essence || ""] || []).push(r); });
        sends.forEach((s) => { (bs[s.essence || ""] = bs[s.essence || ""] || []).push(s); });
        const essences = [...new Set([...Object.keys(br), ...Object.keys(bs)])]
            .sort((a, b) => (ESS_ORDER[a] == null ? 9 : ESS_ORDER[a]) - (ESS_ORDER[b] == null ? 9 : ESS_ORDER[b]));
        const pairs = [], unmatched = [];
        essences.forEach((e) => {
            const rs = (br[e] || []).slice().sort((a, b) => (roleKey(a) < roleKey(b) ? -1 : 1));
            const ss = (bs[e] || []).slice().sort((a, b) => (roleKey(a) < roleKey(b) ? -1 : 1));
            const n = Math.min(rs.length, ss.length);
            for (let i = 0; i < n; i++) pairs.push({ r: rs[i], s: ss[i], essence: e });
            for (let i = n; i < rs.length; i++) unmatched.push(rs[i]);
        });
        return { pairs, unmatched };
    }

    // État d'un croisement (groupé ou non) : full / partial / none.
    function cellState(rowMembers, colMembers) {
        const { pairs } = pairMembers(rowMembers, colMembers);
        let routed = 0;
        pairs.forEach((p) => { if (p.r.active_sender_key === p.s.key) routed++; });
        const colKeys = new Set(colMembers.map((s) => s.key));
        const anyActive = rowMembers.some((r) => r.active_sender_key && colKeys.has(r.active_sender_key));
        let state = "none";
        if (pairs.length) state = routed === pairs.length ? "full" : (routed > 0 || anyActive ? "partial" : "none");
        else state = anyActive ? "partial" : "none";
        return { state, pairs, anyActive, compatible: pairs.length > 0 };
    }

    // ── Construction des axes pour BT.Grid ───────────────────
    function essenceBadges(d, isSource) {
        const ess = d.kind === "group" ? d.essences
            : (d.members[0] && d.members[0].essence ? [d.members[0].essence] : []);
        const out = ess.slice()
            .sort((a, b) => (ESS_ORDER[a] == null ? 9 : ESS_ORDER[a]) - (ESS_ORDER[b] == null ? 9 : ESS_ORDER[b]))
            .map((e) => ({ label: ESS_CHIP[e] || e, cls: e }));
        // marqueur ⏻ « émission désactivée » : uniquement côté source (sender), si tous off
        if (isSource && d.members.length && d.members.every((s) => s.master_enable === false)) {
            out.push({ label: "⏻", cls: "off" });
        }
        if (d.kind === "group" && d.inferred) out.push({ label: "≈", cls: "inferred" });
        return out;
    }
    function descKey(d, prefix) {
        return d.kind === "group" ? ("grp:" + prefix + ":" + d.machine_key + "|" + d.groupName)
            : (d.members[0] && d.members[0].key);
    }
    function toAxisItem(d, isSource, prefix) {
        return {
            key: descKey(d, prefix),
            label: d.label,
            group: { key: d.machine_key, label: (d.members[0] && d.members[0].machine) || d.machine_key },
            badge: essenceBadges(d, isSource),
            active: !isSource && d.members.some((r) => r.active_sender_key),
            _d: d,
        };
    }
    function buildAxes() {
        const sN = (grid.senders || []).filter(itemVisible);
        const rN = (grid.receivers || []).filter(itemVisible);
        const sources = descsFor(sN, "sender").map((d) => toAxisItem(d, true, "s"));
        let destinations = descsFor(rN, "receiver").map((d) => toAxisItem(d, false, "r"));
        if (wiredOnly) destinations = destinations.filter((x) => x.active);
        return { sources, destinations };
    }

    function emptyMsg() {
        return `<div class="ng-meta" style="padding:12px">${esc(tr("plugin.nmos_grid.empty",
            "Aucun sender ou receiver à afficher (parc vide, injoignable, ou filtré)."))}</div>`;
    }

    // ── Rendu : mount BT.Grid une fois, setData ensuite ──────
    function cellFor(src, dst) {
        const st = cellState(dst._d.members, src._d.members);   // rangée=receiver, colonne(source)=sender
        return {
            state: st.state === "full" ? "on" : (st.state === "partial" ? "partial" : "off"),
            clickable: st.compatible,
            title: st.compatible ? null : tr("plugin.nmos_grid.incompatible", "essences incompatibles"),
        };
    }

    async function routeSrcDst(src, dst) {
        const rd = dst._d, cd = src._d;                         // receiver ◄ sender
        if (rd.kind === "group" && cd.kind === "group") {
            let d;
            try {
                d = await ctx.api("take-group", { method: "POST", body: {
                    receiver_group: { machine_key: rd.machine_key, name: rd.groupName },
                    sender_group: { machine_key: cd.machine_key, name: cd.groupName } } });
            } catch (e) { toast(e.message, "error"); return; }
            showReport(tr("plugin.nmos_grid.takeGroupReport", "Take groupé"), d);
        } else {
            const { pairs } = pairMembers(rd.members, cd.members);
            if (!pairs.length) return;
            const p = pairs[0];
            if (p.r.active_sender_key === p.s.key) return;      // déjà actif
            try { await ctx.api("take", { method: "POST", body: { receiver_key: p.r.key, sender_key: p.s.key } }); }
            catch (e) { toast(e.message, "error"); return; }
            toast(tr("plugin.nmos_grid.taken", "Croisement établi"), "success");
        }
        refresh(true);
    }

    async function disconnectDst(dst) {
        const rd = dst._d;
        if (rd.kind === "group") {
            if (!window.confirm(`${tr("plugin.nmos_grid.confirmDiscGroup", "Déconnecter tout le groupe")} « ${rd.label} » ?`)) return;
            let d;
            try { d = await ctx.api("disconnect-group", { method: "POST", body: { receiver_group: { machine_key: rd.machine_key, name: rd.groupName } } }); }
            catch (e) { toast(e.message, "error"); return; }
            showReport(tr("plugin.nmos_grid.disconnectGroupReport", "Déconnexion groupée"), d);
        } else {
            const r = rd.members[0];
            if (!window.confirm(`${tr("plugin.nmos_grid.confirmDisc", "Déconnecter")} « ${r ? r.label : "?"} » ?`)) return;
            try { await ctx.api("disconnect", { method: "POST", body: { receiver_key: r.key } }); }
            catch (e) { toast(e.message, "error"); return; }
            toast(tr("plugin.nmos_grid.disconnected", "Destination déconnectée"), "success");
        }
        refresh(true);
    }

    // clés sender à partir des sources sélectionnées (déplie les groupes)
    function srcKeysFrom(srcs) { return uniq((srcs || []).flatMap((s) => (s._d.members || []).map((m) => m.key)).filter(Boolean)); }

    function renderGrid(remount) {
        const host = $("#ng-grid-wrap");
        $("#ng-legend").hidden = !((grid.senders || []).length || (grid.receivers || []).length);
        const { sources, destinations } = buildAxes();
        if (!sources.length || !destinations.length) {
            if (btGrid) { btGrid.destroy(); btGrid = null; }
            host.innerHTML = emptyMsg();
            return;
        }
        if (remount && btGrid) { btGrid.destroy(); btGrid = null; }
        if (btGrid) { btGrid.setData(sources, destinations); return; }
        host.innerHTML = "";
        btGrid = BT.Grid.mount(host, {
            sources, destinations,
            cell: cellFor, onRoute: routeSrcDst, onDisconnect: disconnectDst,
            preparedText: (src, dst) => `${dst.label} · ${dst.group.label} ◄ ${src.label} · ${src.group.label}`,
            features: { collapse: true, pin: true, jump: true, takeBar: !directTake, select: true },
            selectionActions: [
                { label: tr("plugin.nmos_grid.sdp.view", "Voir SDP"),
                  title: tr("plugin.nmos_grid.sdp.viewTitle", "Afficher le SDP de la source sélectionnée"),
                  onClick: (k, srcs) => {
                      const keys = srcKeysFrom(srcs);
                      if (!keys.length) return;
                      if (keys.length > 1) toast(tr("plugin.nmos_grid.sdp.firstOnly", "SDP de la 1re source sélectionnée"), "info");
                      const s = (grid.senders || []).find((x) => x.key === keys[0]);
                      viewSenderSdp(keys[0], s ? `${s.label} · ${s.machine}` : ""); } },
                { label: tr("plugin.nmos_grid.enable", "Activer"), cls: "btn-green",
                  onClick: (k, srcs) => selEnable(srcKeysFrom(srcs), true) },
                { label: tr("plugin.nmos_grid.disable", "Désactiver"),
                  onClick: (k, srcs) => selEnable(srcKeysFrom(srcs), false) },
                { label: tr("plugin.nmos_grid.relaunch", "Relancer l'émission"),
                  title: tr("plugin.nmos_grid.relaunchTitle", "Désactive puis réactive l'émission (IS-05)"),
                  onClick: (k, srcs) => selRelaunch(srcKeysFrom(srcs)) },
            ],
            labels: {
                corner: tr("plugin.nmos_grid.cornerBt", "dst ▸ / src ▾"),
                take: tr("plugin.nmos_grid.take", "TAKE"),
                cancel: tr("plugin.nmos_grid.cancel", "Annuler"),
                prepared: tr("plugin.nmos_grid.prepared", "Préparé :"),
                selected: tr("plugin.nmos_grid.selectedSrc", "source(s) sélectionnée(s)"),
                selHint: tr("plugin.nmos_grid.shiftHint", "Maj+clic pour en (dé)sélectionner plusieurs"),
                clear: tr("plugin.nmos_grid.clearSel", "Vider"),
            },
            persistKey: GRID_KEY(),
        });
    }

    // ── Actions IS-05 sur la sélection (Activer / Désactiver / Relancer) ──
    async function selEnable(keys, enable) {
        keys = uniq(keys || []); if (!keys.length) return;
        const verb = enable ? tr("plugin.nmos_grid.enable", "Activer") : tr("plugin.nmos_grid.disable", "Désactiver");
        if (!window.confirm(`${verb} ${tr("plugin.nmos_grid.emitOf", "l'émission de")} ${keys.length} ${tr("plugin.nmos_grid.senders", "sender(s)")} ?`)) return;
        let d;
        try { d = await ctx.api("sender-enable", { method: "POST", body: { sender_keys: keys, enable: enable } }); }
        catch (e) { toast(e.message, "error"); return; }
        showSenderReport(verb, d);
        refresh(true);
    }
    async function selRelaunch(keys) {
        keys = uniq(keys || []); if (!keys.length) return;
        if (!window.confirm(`${tr("plugin.nmos_grid.confirmRelaunch", "Relancer l'émission (désactiver puis réactiver) de")} ${keys.length} ${tr("plugin.nmos_grid.senders", "sender(s)")} ?`)) return;
        let d;
        try { d = await ctx.api("bounce-group", { method: "POST", body: { sender_keys: keys } }); }
        catch (e) { toast(e.message, "error"); return; }
        showSenderReport(tr("plugin.nmos_grid.relaunch", "Relancer l'émission"), d);
        refresh(true);
    }

    // ── Nodes manuels ────────────────────────────────────────
    async function onAddNode(ev) {
        ev.preventDefault();
        const body = { name: $("#ng-f-name").value.trim(), host: $("#ng-f-host").value.trim(),
                       port: parseInt($("#ng-f-port").value, 10) || 0 };
        if (!body.host || !body.port) { toast(tr("plugin.nmos_grid.hostRequired", "Adresse et port requis"), "error"); return; }
        try { await ctx.api("nodes", { method: "POST", body }); }
        catch (e) { toast(e.message, "error"); return; }
        $("#ng-f-name").value = $("#ng-f-host").value = $("#ng-f-port").value = "";
        await refresh(true);
        renderManual();
    }

    async function renderManual() {
        let d;
        try { d = await ctx.api("nodes"); } catch (e) { return; }
        const manual = (d.nodes || []).filter((n) => n.source === "manual");
        const box = $("#ng-manual");
        box.innerHTML = manual.map((n) => `<div class="ng-manual-row">
            <span>${esc(n.machine)} <span class="ng-mono">${esc(n.host)}:${n.port}</span></span>
            <button class="btn btn-red ng-del" data-id="${esc(n.node_key.split(":")[1])}">✕</button></div>`).join("");
        box.querySelectorAll(".ng-del").forEach((b) => b.addEventListener("click", async () => {
            try { await ctx.api("nodes/" + b.dataset.id, { method: "DELETE" }); } catch (e) { toast(e.message, "error"); return; }
            renderManual(); refresh(true);
        }));
    }

    // ── SDP : voir une source / coller dans une destination ──
    // Les SDP sont par flux UNITAIRE (un sender / un receiver), pas par groupe : on peuple les
    // sélecteurs à plat depuis la grille courante, triés par machine puis libellé.
    const byMachineLabel = (a, b) =>
        (a.machine + " " + a.label < b.machine + " " + b.label ? -1 : 1);

    function renderSdpSelectors() {
        const srcSel = $("#ng-sdp-src"), dstSel = $("#ng-sdp-dst");
        if (!srcSel || !dstSel) return;
        const opt = (x) => `<option value="${esc(x.key)}">${esc(x.label)} · ${esc(x.machine)}</option>`;
        const sPrev = srcSel.value, dPrev = dstSel.value;
        srcSel.innerHTML = (grid.senders || []).slice().sort(byMachineLabel).map(opt).join("");
        dstSel.innerHTML = (grid.receivers || []).slice().sort(byMachineLabel).map(opt).join("");
        if (sPrev) srcSel.value = sPrev;
        if (dPrev) dstSel.value = dPrev;
    }

    async function viewSenderSdp(key, label) {
        if (!key) { toast(tr("plugin.nmos_grid.sdp.noSrc", "Choisissez une source"), "error"); return; }
        let d;
        try { d = await ctx.api("sender-sdp?sender_key=" + encodeURIComponent(key)); }
        catch (e) { toast(e.message, "error"); return; }
        showSdpModal(label || tr("plugin.nmos_grid.sdp.title", "SDP"), d.sdp || "");
    }

    async function pasteSdp() {
        const dstSel = $("#ng-sdp-dst");
        const key = dstSel.value, sdp = $("#ng-sdp-text").value;
        if (!key) { toast(tr("plugin.nmos_grid.sdp.noDst", "Choisissez une destination"), "error"); return; }
        if (!sdp.trim()) { toast(tr("plugin.nmos_grid.sdp.noSdp", "Collez un SDP"), "error"); return; }
        const dstLabel = dstSel.selectedOptions[0] ? dstSel.selectedOptions[0].textContent : key;
        if (!window.confirm(`${tr("plugin.nmos_grid.sdp.confirm", "Coller ce SDP et activer")} « ${dstLabel} » ?`)) return;
        try { await ctx.api("apply-sdp", { method: "POST", body: { receiver_key: key, sdp } }); }
        catch (e) { toast(e.message, "error"); return; }
        toast(tr("plugin.nmos_grid.sdp.applied", "SDP appliqué (activation immédiate)"), "success");
        $("#ng-sdp-text").value = "";
        refresh(true);
    }

    // ── Modale d'affichage d'un SDP (copier / télécharger) ──
    function closeSdpModal() {
        const m = root && root.querySelector(".ng-modal");
        if (m) m.remove();
        if (sdpEsc) { document.removeEventListener("keydown", sdpEsc); sdpEsc = null; }
    }

    function showSdpModal(title, sdp) {
        closeSdpModal();
        if (!root) return;
        const ov = document.createElement("div");
        ov.className = "ng-modal";
        ov.innerHTML = `<div class="ng-modal-box">
            <div class="ng-modal-head">
              <h4>${esc(title)}</h4><span class="ng-spacer"></span>
              <button class="btn" data-a="copy">${esc(tr("plugin.nmos_grid.sdp.copy", "Copier"))}</button>
              <button class="btn" data-a="dl">${esc(tr("plugin.nmos_grid.sdp.download", "Télécharger"))}</button>
              <button class="btn btn-red" data-a="close">✕</button>
            </div>
            <pre class="ng-modal-pre"></pre></div>`;
        ov.querySelector(".ng-modal-pre").textContent = sdp;     // textContent : aucune injection
        ov.addEventListener("click", (e) => { if (e.target === ov) closeSdpModal(); });
        ov.querySelector('[data-a="close"]').addEventListener("click", closeSdpModal);
        ov.querySelector('[data-a="copy"]').addEventListener("click", () => copyText(sdp));
        ov.querySelector('[data-a="dl"]').addEventListener("click", () => downloadSdp(title, sdp));
        root.appendChild(ov);
        sdpEsc = (e) => { if (e.key === "Escape") closeSdpModal(); };
        document.addEventListener("keydown", sdpEsc);
    }

    function copyText(t) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(t).then(
                () => toast(tr("plugin.nmos_grid.sdp.copied", "SDP copié"), "success"),
                () => toast(tr("plugin.nmos_grid.sdp.copyFail", "Copie impossible"), "error"));
        } else { toast(tr("plugin.nmos_grid.sdp.copyFail", "Copie impossible"), "error"); }
    }

    function slugify(s) { return norm(s).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "sdp"; }

    function downloadSdp(title, sdp) {
        const blob = new Blob([sdp], { type: "application/sdp" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = slugify(title) + ".sdp";
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    // ── Salvos ───────────────────────────────────────────────
    async function loadSalvos() {
        let d;
        try { d = await ctx.api("salvos"); } catch (e) { return; }
        if (!root) return;
        const box = $("#ng-salvos");
        const salvos = d.salvos || [];
        if (!salvos.length) { box.innerHTML = `<div class="ng-meta">${esc(tr("plugin.nmos_grid.noSalvo", "Aucun salvo. « + Depuis le routage courant » capture les croisements actifs."))}</div>`; return; }
        box.innerHTML = salvos.map((s) => `<div class="ng-item">
            <span class="ng-item-name">${esc(s.name)}</span>
            <span class="ng-meta">${(s.crosspoints || []).length} ${esc(tr("plugin.nmos_grid.xpts", "croisement(s)"))} · ${esc(s.created_at || "")}</span>
            <span class="ng-item-actions">
              <button class="btn btn-green ng-s-apply" data-id="${esc(s.id)}">${esc(tr("plugin.nmos_grid.apply", "Appliquer"))}</button>
              <button class="btn ng-s-update" data-id="${esc(s.id)}" title="${esc(tr("plugin.nmos_grid.updateFromCur", "Mettre à jour depuis le routage courant"))}">⟳</button>
              <button class="btn ng-s-rename" data-id="${esc(s.id)}">${esc(tr("plugin.nmos_grid.rename", "Renommer"))}</button>
              <button class="btn btn-red ng-s-del" data-id="${esc(s.id)}">✕</button>
            </span></div>`).join("");
        box.querySelectorAll(".ng-s-apply").forEach((b) => b.addEventListener("click", () => applySalvo(b.dataset.id)));
        box.querySelectorAll(".ng-s-update").forEach((b) => b.addEventListener("click", () => updateSalvo(b.dataset.id)));
        box.querySelectorAll(".ng-s-rename").forEach((b) => b.addEventListener("click", () => renameSalvo(b.dataset.id)));
        box.querySelectorAll(".ng-s-del").forEach((b) => b.addEventListener("click", () => delSalvo(b.dataset.id)));
    }

    async function newSalvo() {
        const name = window.prompt(tr("plugin.nmos_grid.salvoName", "Nom du salvo (capture les croisements actifs) :"));
        if (!name) return;
        try { await ctx.api("salvos", { method: "POST", body: { name } }); }
        catch (e) { toast(e.message, "error"); return; }
        loadSalvos();
    }

    async function updateSalvo(id) {
        if (!window.confirm(tr("plugin.nmos_grid.updateConfirm", "Remplacer les croisements de ce salvo par le routage courant ?"))) return;
        try { await ctx.api("salvos/" + id, { method: "PUT", body: { from_current: true } }); }
        catch (e) { toast(e.message, "error"); return; }
        toast(tr("plugin.nmos_grid.updated", "Salvo mis à jour"), "success");
        loadSalvos();
    }

    async function renameSalvo(id) {
        const name = window.prompt(tr("plugin.nmos_grid.rename", "Renommer") + " :");
        if (!name) return;
        try { await ctx.api("salvos/" + id, { method: "PUT", body: { name } }); }
        catch (e) { toast(e.message, "error"); return; }
        loadSalvos();
    }

    async function delSalvo(id) {
        if (!window.confirm(tr("plugin.nmos_grid.delConfirm", "Supprimer ?"))) return;
        try { await ctx.api("salvos/" + id, { method: "DELETE" }); } catch (e) { toast(e.message, "error"); return; }
        loadSalvos();
    }

    async function applySalvo(id) {
        if (!window.confirm(tr("plugin.nmos_grid.applyConfirm", "Appliquer ce salvo (re-route les destinations concernées) ?"))) return;
        let d;
        try { d = await ctx.api("salvos/" + id + "/apply", { method: "POST" }); }
        catch (e) { toast(e.message, "error"); return; }
        showReport(tr("plugin.nmos_grid.salvoReport", "Application du salvo"), d);
        refresh(true);
    }

    // ── Snapshots ────────────────────────────────────────────
    async function loadSnapshots() {
        let d;
        try { d = await ctx.api("snapshots"); } catch (e) { return; }
        if (!root) return;
        const box = $("#ng-snaps");
        const snaps = d.snapshots || [];
        if (!snaps.length) { box.innerHTML = `<div class="ng-meta">${esc(tr("plugin.nmos_grid.noSnap", "Aucun snapshot. « Photographier le routage » enregistre l'état complet."))}</div>`; return; }
        box.innerHTML = snaps.map((s) => `<div class="ng-item">
            <span class="ng-item-name">${esc(s.name)}</span>
            <span class="ng-meta">${s.active_count || 0} ${esc(tr("plugin.nmos_grid.active", "actif(s)"))} · ${esc(s.taken_at || "")}</span>
            <span class="ng-item-actions">
              <button class="btn btn-green ng-n-apply" data-id="${esc(s.id)}">${esc(tr("plugin.nmos_grid.recall", "Rappeler"))}</button>
              <button class="btn btn-red ng-n-del" data-id="${esc(s.id)}">✕</button>
            </span></div>`).join("");
        box.querySelectorAll(".ng-n-apply").forEach((b) => b.addEventListener("click", () => recallSnap(b.dataset.id)));
        box.querySelectorAll(".ng-n-del").forEach((b) => b.addEventListener("click", () => delSnap(b.dataset.id)));
    }

    async function newSnapshot() {
        const name = window.prompt(tr("plugin.nmos_grid.snapName", "Nom du snapshot (photo du routage complet) :"));
        if (!name) return;
        try { await ctx.api("snapshots", { method: "POST", body: { name } }); }
        catch (e) { toast(e.message, "error"); return; }
        loadSnapshots();
    }

    async function recallSnap(id) {
        if (!window.confirm(tr("plugin.nmos_grid.recallConfirm", "Rappeler ce snapshot ? Le routage complet sera ré-appliqué."))) return;
        let d;
        try { d = await ctx.api("snapshots/" + id + "/apply", { method: "POST" }); }
        catch (e) { toast(e.message, "error"); return; }
        showReport(tr("plugin.nmos_grid.snapReport", "Rappel du snapshot"), d);
        refresh(true);
    }

    async function delSnap(id) {
        if (!window.confirm(tr("plugin.nmos_grid.delConfirm", "Supprimer ?"))) return;
        try { await ctx.api("snapshots/" + id, { method: "DELETE" }); } catch (e) { toast(e.message, "error"); return; }
        loadSnapshots();
    }

    // ── Rapports ─────────────────────────────────────────────
    function showReport(title, d) {
        const box = $("#ng-report");
        box.hidden = false;
        const results = (d && d.results) || [];
        const ok = d.ok_count || 0, fail = d.fail_count || 0, nomatch = d.nomatch_count || 0;
        const kind = fail ? "error" : "success";
        const summary = `${ok} ${tr("plugin.nmos_grid.ok", "ok")}, ${fail} ${tr("plugin.nmos_grid.fail", "échec(s)")}` +
            (nomatch ? `, ${nomatch} ${tr("plugin.nmos_grid.nomatch", "sans correspondance")}` : "");
        toast(`${title} : ${summary}`, kind);
        box.innerHTML = `<h4>${esc(title)} — ${esc(summary)}</h4>` +
            results.map((r) => {
                const st = r.status || (r.ok ? "ok" : "fail");
                const ico = st === "ok" ? "✅" : (st === "no_match" ? "⚪" : "🔴");
                const src = st === "no_match"
                    ? esc(tr("plugin.nmos_grid.nomatch", "sans correspondance"))
                    : esc(r.sender_label || (r.sender_key ? r.sender_key : tr("plugin.nmos_grid.disconnect2", "déconnexion")));
                return `<div class="ng-rep-line ${esc(st)}">${ico} ${esc(r.receiver_label || r.receiver_key)} ◄ ${src}${r.error ? " — " + esc(r.error) : ""}</div>`;
            }).join("");
    }

    // Rapport orienté sender (Activer / Désactiver / Relancer).
    function showSenderReport(title, d) {
        const box = $("#ng-report"); box.hidden = false;
        const results = (d && d.results) || [];
        const ok = (d && d.ok_count) || 0, fail = (d && d.fail_count) || 0;
        const summary = `${ok} ${tr("plugin.nmos_grid.ok", "ok")}, ${fail} ${tr("plugin.nmos_grid.fail", "échec(s)")}`;
        toast(`${title} : ${summary}`, fail ? "error" : "success");
        const labelOf = (sk) => { const s = (grid.senders || []).find((x) => x.key === sk); return s ? (s.label + " · " + s.machine) : sk; };
        box.innerHTML = `<h4>${esc(title)} — ${esc(summary)}</h4>` +
            results.map((r) => {
                const st = r.status || (r.ok ? "ok" : "fail");
                const ico = st === "ok" ? "✅" : "🔴";
                return `<div class="ng-rep-line ${esc(st)}">${ico} ${esc(labelOf(r.sender_key))}${r.error ? " — " + esc(r.error) : ""}</div>`;
            }).join("");
    }

    return { mount, unmount };
})();
