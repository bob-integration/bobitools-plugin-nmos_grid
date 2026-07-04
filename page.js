// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 BOBI SAS, France
// Auteur : Cyril Mazouer, pour le compte de BOBI SAS
// Distribué sous licence GNU GPL v3 (ou ultérieure) ; voir le fichier LICENSE.

// UI de « Grille NMOS ». Front pur : toute la logique tourne dans le conteneur, atteinte via
// ctx.api(...). Matrice X/Y (senders en colonnes, receivers en lignes) filtrable par essence,
// machine et recherche libre. Deux VUES : « par flux » (un croisement par signal) et « par
// signal » (BCP-002-01 : une colonne/ligne par groupe, take groupé). Repli par équipement,
// favoris (machines épinglées), mode « câblées uniquement », TAKE, salvos et snapshots.
// Les préférences d'affichage sont persistées en localStorage (clé préfixée par le type).
window.BTTools = window.BTTools || {};
window.BTTools.nmos_grid = (function () {
    "use strict";
    let ctx = null, root = null;
    let grid = { senders: [], receivers: [], machines: [], simulated: false };
    let filters = { essence: "", machine: "" };
    let search = "";                    // recherche libre (NON persistée)
    let view = "flux";                  // "flux" | "signal"
    let wiredOnly = false;              // masque les destinations sans croisement actif
    let collapsedS = new Set();         // machine_key des colonnes (sources) repliées
    let collapsedR = new Set();         // machine_key des lignes (destinations) repliées
    let pinned = new Set();             // machine_key épinglées (en tête des deux axes)
    let pending = null;                 // { kind:"single"|"group", ... }
    let pollTimer = null;
    let curRows = [], curCols = [];     // descripteurs courants (résolution des clics par index)

    const esc = (s) => (window.BT && BT.esc ? BT.esc(s) : String(s == null ? "" : s));
    const tr = (key, fb) => { const v = ctx && ctx.t ? ctx.t(key) : null; return (v && v !== key) ? v : fb; };
    const $ = (sel) => root.querySelector(sel);
    const toast = (m, k) => ctx.toast(m, k);
    const POLL_MS = 7000;
    const ESS_ORDER = { video: 0, audio: 1, data: 2 };
    const ESS_CHIP = { video: "V", audio: "A", data: "ANC" };

    // Normalisation pour la recherche : minuscules + suppression des accents.
    const norm = (s) => (s == null ? "" : String(s)).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

    // ── Persistance des préférences (localStorage, clé préfixée par le type) ──
    const PREF_KEY = () => "bt:" + (ctx && ctx.type ? ctx.type : "nmos_grid") + ":prefs";
    function loadPrefs() {
        let p = {};
        try { p = JSON.parse(window.localStorage.getItem(PREF_KEY()) || "{}") || {}; } catch (e) { p = {}; }
        if (p.view === "signal" || p.view === "flux") view = p.view;
        filters.essence = p.essence || ""; filters.machine = p.machine || "";
        wiredOnly = !!p.wiredOnly;
        collapsedS = new Set(Array.isArray(p.collapsedS) ? p.collapsedS : []);
        collapsedR = new Set(Array.isArray(p.collapsedR) ? p.collapsedR : []);
        pinned = new Set(Array.isArray(p.pinned) ? p.pinned : []);
    }
    function savePrefs() {
        try {
            window.localStorage.setItem(PREF_KEY(), JSON.stringify({
                view, essence: filters.essence, machine: filters.machine, wiredOnly,
                collapsedS: [...collapsedS], collapsedR: [...collapsedR], pinned: [...pinned]
            }));
        } catch (e) { /* quota / mode privé : on ignore */ }
    }

    // ── Cycle de vie ─────────────────────────────────────────
    function mount(el, context) {
        ctx = context; root = el;
        loadPrefs();
        applyI18n();
        // reflète les préférences dans les contrôles
        $("#ng-f-view").value = view;
        $("#ng-f-essence").value = filters.essence;
        $("#ng-f-wired").checked = wiredOnly;
        $("#ng-refresh").addEventListener("click", () => refresh(true));
        $("#ng-add").addEventListener("click", () => { $("#ng-form").hidden = false; renderManual(); });
        $("#ng-f-cancel").addEventListener("click", () => { $("#ng-form").hidden = true; });
        $("#ng-form").addEventListener("submit", onAddNode);
        $("#ng-search").addEventListener("input", (e) => { search = e.target.value || ""; renderGrid(); });
        $("#ng-f-view").addEventListener("change", (e) => { view = e.target.value; savePrefs(); clearPending(); renderGrid(); });
        $("#ng-f-essence").addEventListener("change", (e) => { filters.essence = e.target.value; savePrefs(); renderGrid(); });
        $("#ng-f-machine").addEventListener("change", (e) => { filters.machine = e.target.value; savePrefs(); renderGrid(); });
        $("#ng-f-wired").addEventListener("change", (e) => { wiredOnly = e.target.checked; savePrefs(); renderGrid(); });
        $("#ng-take-do").addEventListener("click", doTake);
        $("#ng-take-cancel").addEventListener("click", clearPending);
        $("#ng-salvo-new").addEventListener("click", newSalvo);
        $("#ng-snap-new").addEventListener("click", newSnapshot);
        refresh(true);
        loadSalvos();
        loadSnapshots();
        pollTimer = setInterval(() => refresh(false), POLL_MS);
    }

    function unmount() {
        if (pollTimer) clearInterval(pollTimer);
        ctx = root = null; pending = null;
        grid = { senders: [], receivers: [], machines: [], simulated: false };
        curRows = []; curCols = [];
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

    // ── Chargement de la grille ──────────────────────────────
    async function refresh(fresh) {
        let d;
        try { d = await ctx.api("grid" + (fresh ? "?fresh=1" : "")); }
        catch (e) { if (fresh) toast(e.message, "error"); return; }
        if (!root) return;
        grid = d || grid;
        $("#ng-sim").hidden = !grid.simulated;
        $("#ng-sim-hint").hidden = !grid.simulated;
        if (pending) {                       // abandonne un préparé devenu caduc
            if (pending.kind === "single" && !grid.receivers.some((r) => r.key === pending.receiver_key)) clearPending();
        }
        renderMachineFilter();
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

    // ── Machines ordonnées (épinglées en tête), à partir d'items filtrés ──
    function orderedMachines(items) {
        const map = new Map();
        items.forEach((it) => {
            if (!map.has(it.machine_key)) map.set(it.machine_key, { machine_key: it.machine_key, name: it.machine, items: [] });
            map.get(it.machine_key).items.push(it);
        });
        const list = [...map.values()];
        // tri stable : épinglées d'abord, ordre d'origine préservé au sein de chaque groupe
        return list.map((m, i) => [m, i]).sort((a, b) => {
            const pa = pinned.has(a[0].machine_key) ? 0 : 1, pb = pinned.has(b[0].machine_key) ? 0 : 1;
            return pa - pb || a[1] - b[1];
        }).map((x) => x[0]);
    }

    // ── Descripteurs de colonnes / lignes selon la vue ───────
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

    function machineEssences(items) {
        const out = [];
        items.forEach((it) => { if (it.essence && out.indexOf(it.essence) < 0) out.push(it.essence); });
        return out;
    }

    // « Croisements actifs cachés » d'une machine repliée (indicateur d'en-tête).
    function senderMachineActive(mk) {
        const keys = new Set((grid.senders || []).filter((s) => s.machine_key === mk).map((s) => s.key));
        return (grid.receivers || []).some((r) => r.active_sender_key && keys.has(r.active_sender_key));
    }
    function receiverMachineActive(mk) {
        return (grid.receivers || []).some((r) => r.machine_key === mk && r.active_sender_key);
    }

    // ── Appariement des essences (identique au serveur) ──────
    function roleKey(x) { const g = x.group || {}; return (g.role || "") + " " + (x.label || ""); }
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

    // État d'un croisement (groupé ou non) : full / partial / none, calculé depuis /grid.
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

    // ── Rendu de la matrice ──────────────────────────────────
    function emptyMsg() {
        return `<div class="ng-meta" style="padding:12px">${esc(tr("plugin.nmos_grid.empty",
            "Aucun sender ou receiver à afficher (parc vide, injoignable, ou filtré)."))}</div>`;
    }

    function essChips(desc) {
        if (desc.kind === "group" || desc.kind === "mcol") {
            return (desc.essences || []).map((e) => `<span class="ng-ess ${esc(e)}">${esc(ESS_CHIP[e] || e)}</span>`).join("");
        }
        const e = desc.members[0] && desc.members[0].essence;
        return e ? `<span class="ng-ess ${esc(e)}">${esc(e)}</span>` : "";
    }

    function pinStar(mk) {
        const on = pinned.has(mk);
        return `<button class="ng-pin${on ? " on" : ""}" data-mk="${esc(mk)}" title="${esc(tr("plugin.nmos_grid.pin", "Épingler en tête"))}">${on ? "★" : "☆"}</button>`;
    }
    function mToggle(side, mk, collapsed) {
        return `<button class="ng-mtoggle" data-side="${side}" data-mk="${esc(mk)}" title="${esc(collapsed ? tr("plugin.nmos_grid.expand", "Déplier") : tr("plugin.nmos_grid.collapse", "Replier"))}">${collapsed ? "▸" : "▾"}</button>`;
    }
    const hiddenDot = (on) => on ? `<span class="ng-hid" title="${esc(tr("plugin.nmos_grid.hiddenActive", "croisements actifs masqués"))}">●</span>` : "";

    // Construit la liste des descripteurs de colonnes + les en-têtes de groupe (machines).
    function buildCols() {
        const senders = (grid.senders || []).filter(itemVisible);
        const machines = orderedMachines(senders);
        const cols = [], headGroups = [];
        machines.forEach((m) => {
            if (collapsedS.has(m.machine_key)) {
                cols.push({ kind: "mcol", members: m.items, label: m.name, machine_key: m.machine_key,
                    essences: machineEssences(m.items) });
                headGroups.push({ machine_key: m.machine_key, name: m.name, span: 1, collapsed: true });
            } else {
                const ds = descsFor(m.items, "sender");
                ds.forEach((d) => cols.push(d));
                headGroups.push({ machine_key: m.machine_key, name: m.name, span: ds.length, collapsed: false });
            }
        });
        return { cols, headGroups };
    }

    function renderCell(rd, c, ri, ci) {
        const parked = rd.kind === "mcol" || c.kind === "mcol";
        const st = cellState(rd.members, c.members);
        let cls = "ng-cell ng-c-" + st.state;
        if (parked) cls += " parked";
        if (!parked && !st.compatible) cls += " disabled";
        if (!parked && pendingMatches(rd, c)) cls += " pending";
        const clickable = !parked && st.compatible;
        if (clickable) cls += " clickable";
        const attr = clickable ? ` data-ri="${ri}" data-ci="${ci}"` : "";
        let mark = "";
        if (st.state === "full") mark = "●";       // ●
        else if (st.state === "partial") mark = "◐"; // ◐
        return `<td class="${cls}"${attr}><span class="ng-dot">${mark}</span></td>`;
    }

    function rowDiscButton(rd, ri) {
        const active = rd.members.some((r) => r.active_sender_key);
        if (!active || rd.kind === "mcol") return "";
        return `<button class="btn btn-red ng-disc" data-ri="${ri}" title="${esc(tr("plugin.nmos_grid.disconnect", "Déconnecter"))}">✕</button>`;
    }

    function renderRow(rd, cols, ri) {
        let rowh;
        if (rd.kind === "mcol") {                    // machine repliée : en-tête fin, ligne unique
            rowh = `<th class="ng-row-h ng-row-mcol">
                <div class="ng-rowh-flex"><div class="ng-mgrp">
                  ${mToggle("r", rd.machine_key, true)}${pinStar(rd.machine_key)}
                  <span class="ng-mname">${esc(rd.label)}</span>
                  <span class="ng-meta">(${rd.members.length})</span>${hiddenDot(receiverMachineActive(rd.machine_key))}
                </div></div></th>`;
        } else {
            const sub = rd.kind === "group"
                ? `<div class="ng-mac">${rd.inferred ? `<span class="ng-inferred" title="${esc(tr("plugin.nmos_grid.inferred", "groupe déduit du libellé"))}">≈</span> ` : ""}${rd.members.length} ${esc(tr("plugin.nmos_grid.signals", "signaux"))}</div>`
                : "";
            rowh = `<th class="ng-row-h"><div class="ng-rowh-flex"><div>
                <div class="ng-cell-lbl">${esc(rd.label)}${essChips(rd)}</div>${sub}</div>
                ${rowDiscButton(rd, ri)}</div></th>`;
        }
        let tds = "";
        cols.forEach((c, ci) => { tds += renderCell(rd, c, ri, ci); });
        return `<tr>${rowh}${tds}</tr>`;
    }

    function renderGrid() {
        const wrap = $("#ng-grid-wrap");
        const { cols, headGroups } = buildCols();
        let recvItems = (grid.receivers || []).filter(itemVisible);
        const rmachines = orderedMachines(recvItems);
        $("#ng-legend").hidden = !((grid.senders || []).length || (grid.receivers || []).length);
        if (!cols.length || !rmachines.length) { wrap.innerHTML = emptyMsg(); curRows = []; curCols = []; return; }

        curCols = cols;
        curRows = [];
        const totalCols = cols.length + 1;

        // thead : ligne 1 = en-têtes de machine (sources), ligne 2 = colonnes (signaux/groupes)
        let grpHead = `<tr><th class="ng-corner" rowspan="2"><span class="ng-meta">${esc(tr("plugin.nmos_grid.srcDst", "src ▸ / dst ▾"))}</span></th>`;
        headGroups.forEach((h) => {
            grpHead += `<th class="ng-grp-col-h" colspan="${h.span}"><div class="ng-mgrp">
                ${mToggle("s", h.machine_key, h.collapsed)}${pinStar(h.machine_key)}
                <span class="ng-mname">${esc(h.name)}</span>${h.collapsed ? hiddenDot(senderMachineActive(h.machine_key)) : ""}
            </div></th>`;
        });
        grpHead += "</tr>";
        let colHead = "<tr>";
        cols.forEach((c) => {
            if (c.kind === "mcol") {
                colHead += `<th class="ng-col-h ng-col-mcol" title="${esc(c.label)}"><div class="ng-cell-lbl">${c.members.length} ${esc(tr("plugin.nmos_grid.signals", "signaux"))}</div><div class="ng-mac">${essChips(c)}</div></th>`;
            } else {
                const sub = c.kind === "group"
                    ? `<div class="ng-mac">${c.inferred ? `<span class="ng-inferred" title="${esc(tr("plugin.nmos_grid.inferred", "groupe déduit du libellé"))}">≈</span> ` : ""}${c.members.length} sig.</div>`
                    : "";
                colHead += `<th class="ng-col-h" title="${esc(c.label)}"><div class="ng-cell-lbl">${esc(c.label)}${essChips(c)}</div>${sub}</th>`;
            }
        });
        colHead += "</tr>";

        // tbody : pour chaque machine (destinations), en-tête de groupe puis ses lignes.
        let body = "";
        rmachines.forEach((m) => {
            const collapsed = collapsedR.has(m.machine_key);
            if (collapsed) {
                if (wiredOnly && !receiverMachineActive(m.machine_key)) return;   // repliée & aucune active
                const rd = { kind: "mcol", members: m.items, label: m.name, machine_key: m.machine_key,
                    essences: machineEssences(m.items) };
                const ri = curRows.length; curRows.push(rd);
                body += renderRow(rd, cols, ri);
                return;
            }
            let rds = descsFor(m.items, "receiver");
            if (wiredOnly) rds = rds.filter((rd) => rd.members.some((r) => r.active_sender_key));
            if (!rds.length) return;   // machine sans ligne visible → disparaît (en-tête compris)
            body += `<tr class="ng-grp-row"><th class="ng-grp-row-h" colspan="${totalCols}"><span class="ng-mgrp">
                ${mToggle("r", m.machine_key, false)}${pinStar(m.machine_key)}
                <span class="ng-mname">${esc(m.name)}</span></span></th></tr>`;
            rds.forEach((rd) => { const ri = curRows.length; curRows.push(rd); body += renderRow(rd, cols, ri); });
        });
        if (!body) { wrap.innerHTML = emptyMsg(); curRows = []; return; }

        wrap.innerHTML = `<table class="ng-matrix"><thead>${grpHead}${colHead}</thead><tbody>${body}</tbody></table>`;
        // aligne les colonnes collantes sous la ligne d'en-têtes de machine (hauteur mesurée)
        const gh = wrap.querySelector(".ng-grp-col-h");
        if (gh) wrap.style.setProperty("--ng-grp-h", gh.offsetHeight + "px");

        wrap.querySelectorAll(".ng-cell.clickable").forEach((td) =>
            td.addEventListener("click", () => onCellClick(+td.dataset.ri, +td.dataset.ci)));
        wrap.querySelectorAll(".ng-disc").forEach((b) =>
            b.addEventListener("click", (ev) => { ev.stopPropagation(); onDisconnect(+b.dataset.ri); }));
        wrap.querySelectorAll(".ng-mtoggle").forEach((b) =>
            b.addEventListener("click", (ev) => { ev.stopPropagation(); onToggleMachine(b.dataset.side, b.dataset.mk); }));
        wrap.querySelectorAll(".ng-pin").forEach((b) =>
            b.addEventListener("click", (ev) => { ev.stopPropagation(); onTogglePin(b.dataset.mk); }));
    }

    // ── Repli / favoris ──────────────────────────────────────
    function onToggleMachine(side, mk) {
        const set = side === "s" ? collapsedS : collapsedR;
        if (set.has(mk)) set.delete(mk); else set.add(mk);
        savePrefs(); renderGrid();
    }
    function onTogglePin(mk) {
        if (pinned.has(mk)) pinned.delete(mk); else pinned.add(mk);
        savePrefs(); renderGrid();
    }

    // ── Préparer / take (simple ou groupé) ───────────────────
    function onCellClick(ri, ci) {
        const rd = curRows[ri], c = curCols[ci];
        if (!rd || !c || rd.kind === "mcol" || c.kind === "mcol") return;   // machine repliée = parké
        const { pairs } = pairMembers(rd.members, c.members);
        if (!pairs.length) return;
        if (rd.kind === "group" && c.kind === "group") prepareGroup(rd, c);
        else prepareSingle(pairs[0].r, pairs[0].s);
    }

    function prepareSingle(r, s) {
        if (r.active_sender_key === s.key) { clearPending(); return; }
        if (pending && pending.kind === "single" && pending.receiver_key === r.key && pending.sender_key === s.key) { clearPending(); return; }
        pending = { kind: "single", receiver_key: r.key, sender_key: s.key,
            rLabel: r.label + " · " + r.machine, sLabel: s.label + " · " + s.machine };
        renderPendingBar(); renderGrid();
    }

    function prepareGroup(rd, cd) {
        if (pending && pending.kind === "group"
            && pending.receiver_group.machine_key === rd.machine_key && pending.receiver_group.name === rd.groupName
            && pending.sender_group.machine_key === cd.machine_key && pending.sender_group.name === cd.groupName) { clearPending(); return; }
        pending = { kind: "group",
            receiver_group: { machine_key: rd.machine_key, name: rd.groupName },
            sender_group: { machine_key: cd.machine_key, name: cd.groupName },
            rLabel: rd.label + " · " + rd.members[0].machine, sLabel: cd.label + " · " + cd.members[0].machine };
        renderPendingBar(); renderGrid();
    }

    function pendingMatches(rd, c) {
        if (!pending) return false;
        if (pending.kind === "single") {
            const { pairs } = pairMembers(rd.members, c.members);
            return pairs.some((p) => p.r.key === pending.receiver_key && p.s.key === pending.sender_key);
        }
        return rd.kind === "group" && c.kind === "group"
            && rd.machine_key === pending.receiver_group.machine_key && rd.groupName === pending.receiver_group.name
            && c.machine_key === pending.sender_group.machine_key && c.groupName === pending.sender_group.name;
    }

    function renderPendingBar() {
        const bar = $("#ng-take-bar");
        if (!pending) { bar.hidden = true; return; }
        bar.hidden = false;
        const tag = pending.kind === "group" ? ` <span class="ng-grp-tag">${esc(tr("plugin.nmos_grid.grouped", "groupé"))}</span>` : "";
        $("#ng-take-txt").innerHTML = `${esc(tr("plugin.nmos_grid.prepared", "Préparé :"))} ` +
            `<strong>${esc(pending.rLabel)}</strong> ◄ <strong>${esc(pending.sLabel)}</strong>${tag}`;
    }

    function clearPending() {
        pending = null;
        if (root) { $("#ng-take-bar").hidden = true; renderGrid(); }
    }

    async function doTake() {
        if (!pending) return;
        if (pending.kind === "group") return doTakeGroup();
        const msg = `${tr("plugin.nmos_grid.confirmTake", "Router")} « ${pending.sLabel} » → « ${pending.rLabel} » ?`;
        if (!window.confirm(msg)) return;
        try { await ctx.api("take", { method: "POST", body: { receiver_key: pending.receiver_key, sender_key: pending.sender_key } }); }
        catch (e) { toast(e.message, "error"); return; }
        toast(tr("plugin.nmos_grid.taken", "Croisement établi"), "success");
        clearPending();
        refresh(true);
    }

    async function doTakeGroup() {
        const msg = `${tr("plugin.nmos_grid.confirmTakeGroup", "Router le signal (groupé)")} « ${pending.sLabel} » → « ${pending.rLabel} » ?`;
        if (!window.confirm(msg)) return;
        let d;
        try { d = await ctx.api("take-group", { method: "POST", body: { receiver_group: pending.receiver_group, sender_group: pending.sender_group } }); }
        catch (e) { toast(e.message, "error"); return; }
        showReport(tr("plugin.nmos_grid.takeGroupReport", "Take groupé"), d);
        clearPending();
        refresh(true);
    }

    // ── Déconnexion (simple ou groupée) ──────────────────────
    function onDisconnect(ri) {
        const rd = curRows[ri];
        if (!rd) return;
        if (rd.kind === "group") disconnectGroup(rd);
        else disconnectSingle(rd.members[0]);
    }

    async function disconnectSingle(r) {
        if (!window.confirm(`${tr("plugin.nmos_grid.confirmDisc", "Déconnecter")} « ${r ? r.label : "?"} » ?`)) return;
        try { await ctx.api("disconnect", { method: "POST", body: { receiver_key: r.key } }); }
        catch (e) { toast(e.message, "error"); return; }
        toast(tr("plugin.nmos_grid.disconnected", "Destination déconnectée"), "success");
        refresh(true);
    }

    async function disconnectGroup(rd) {
        if (!window.confirm(`${tr("plugin.nmos_grid.confirmDiscGroup", "Déconnecter tout le groupe")} « ${rd.label} » ?`)) return;
        let d;
        try { d = await ctx.api("disconnect-group", { method: "POST", body: { receiver_group: { machine_key: rd.machine_key, name: rd.groupName } } }); }
        catch (e) { toast(e.message, "error"); return; }
        showReport(tr("plugin.nmos_grid.disconnectGroupReport", "Déconnexion groupée"), d);
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

    // ── Rapport succès / échec / pas de correspondance ───────
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

    return { mount, unmount };
})();
