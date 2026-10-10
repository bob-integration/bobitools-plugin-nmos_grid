# Grille NMOS — plugin Bobi.Tools

Un **routeur logiciel ST 2110** posé sur **NMOS IS-04 / IS-05**, pour
[Bobi.Tools](https://github.com/bob-integration/bobitools) : une matrice sources × destinations
comme sur un routeur de régie, où un croisement allumé signifie que le receiver est
réellement abonné au sender.

## Ce que fait l'outil

- **Grille X/Y** : senders en colonnes, receivers en lignes, groupés par machine. L'état de
  chaque croisement est lu en IS-05 (`/active`), par `sender_id` ou à défaut par
  corrélation de l'adresse multicast et du port.
- **TAKE** : le SDP du sender est appliqué au receiver (PATCH *staged*, activation
  immédiate). Mode « TAKE direct » pour router d'un clic ; déconnexion par destination.
- **Vue par flux ou par signal** : regroupement *Natural Grouping* BCP-002-01 (grouphint,
  sinon repli sur le préfixe commun des libellés), avec take groupé qui apparie les
  essences et rend un rapport ligne à ligne.
- **Salvos** (ensembles nommés de croisements) et **instantanés** (routage complet,
  déconnexions comprises), rejouables avec rapport par croisement.
- **SDP intégré** : voir le SDP d'une source, voir celui d'une destination, coller un SDP et
  abonner.
- Repli par équipement, favoris, recherche, filtre « câblées uniquement ».

## À savoir

- Un TAKE abonne ou désabonne un équipement **réel** et reroute un flux multicast sur le
  réseau média. Le mode « TAKE direct » supprime l'étape préparer / TAKE : à activer en
  connaissance de cause.
- Tant que le parc est vide (ou que l'outil Parc NMOS est absent), la grille bascule sur un
  **parc simulé** de trois machines, signalé par un bandeau : toute l'interface est testable
  sans matériel.
- Les groupes BCP-002-01 sont interprétés **par Device** : deux « SDI 1 » venus de deux
  Devices sont deux signaux. Ce cas n'a été validé que sur un faux node écrit pour l'occasion.

## Prérequis

- **Bobi.Tools** avec **Docker** : l'outil tourne en conteneur (`runtime: docker`).
- Le plugin **[Parc NMOS](https://github.com/bob-integration/bobitools-plugin-nmos_parc)**
  (`nmos_parc`) : la grille n'a aucun inventaire propre et lit son `park.json` **en lecture
  seule** (volume partagé).
- Des équipements NMOS exposant IS-04 et IS-05.

## Installation

Dans Bobi.Tools : **Réglages → Outils → Catalogue**, bouton « Installer ». Ou, sur une machine
neuve, en une ligne :

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/bob-integration/bobitools/main/get.sh) --outils nmos_grid
```

L'aide complète est dans [`help.md`](help.md), affichée dans Bobi.Tools (menu « ? » → Aide).

## Sécurité

- Le conteneur n'a pas d'authentification propre : son port n'est publié que sur `127.0.0.1`,
  il n'est donc joignable qu'à travers Bobi.Tools, qui contrôle les droits.
- Les gestes sont soumis à des permissions distinctes (commuter un croisement, piloter les
  émetteurs, rappeler un salvo, restaurer un instantané, gérer salvos et instantanés), et
  le take peut être restreint à certains récepteurs.

## In English

A **software ST 2110 router** on top of **NMOS IS-04 / IS-05** for Bobi.Tools: an X/Y grid of
senders × receivers, live crosspoint state read from IS-05, one-click TAKE (sender SDP
applied to the receiver's staged endpoint), per-flow or per-signal view (BCP-002-01 natural
grouping) with grouped takes, salvos, full-routing snapshots and SDP viewing/pasting. A
built-in simulated park allows testing without hardware. Requires Docker and the `nmos_parc`
plugin (read-only shared park).

## Licence

GPL-3.0-or-later — © 2026 BOBI SAS. Voir [LICENSE](LICENSE).
