# Grille NMOS

Un **routeur logiciel ST 2110** posé par-dessus **NMOS** (IS-04 / IS-05). L'écran est une
**matrice X/Y** comme sur un routeur de régie : les **sources** (senders) en colonnes, les
**destinations** (receivers) en lignes. Un point de croisement allumé = cette destination est
**actuellement abonnée** à cette source. Cliquer un croisement le prépare ; un **TAKE**
l'établit réellement. Cochez **TAKE direct** dans la barre d'outils pour router d'un seul clic,
sans l'étape « préparer / TAKE » (pratique en exploitation ; préférence mémorisée).

> **Replier / déplier un équipement** : cliquez directement sur **son nom** dans la grille
> (le chevron ▸/▾ n'est qu'un indicateur). Vaut pour les sources comme les destinations.

L'outil ne possède aucun inventaire propre : le parc appartient à l'outil **« Parc NMOS »**,
qui le publie et que la grille lit en lecture seule. On y ajoute ou retire un équipement une
seule fois, et **tous les outils NMOS suivent** — la grille, le diagnostic, la supervision
BCP-008, la synchro PTP et les sauvegardes de configuration.

Le bouton **Parc** affiche ce que la grille voit, regroupé par châssis. Il répond à la
question « pourquoi cette machine n'est-elle pas dans la grille ? » sans quitter l'écran :
si elle n'y figure pas, elle n'est pas déclarée dans « Parc NMOS » ; si elle y figure sans
sources ni destinations, c'est son NMOS qui ne répond pas.

> **Mode simulation.** Tant que le parc est vide, l'outil bascule sur un **parc SIMULÉ** — 3 machines avec senders/receivers vidéo et
> audio — dont le routage est mémorisé localement. Toute l'interface (takes, salvos, snapshots)
> est ainsi testable **sans matériel**. Un bandeau *SIMULATION* le signale. Dès qu'un vrai node
> apparaît, la grille pilote le matériel réel.

## Lire la grille

- Chaque **colonne** est un sender, chaque **ligne** un receiver, avec leur **essence**
  (vidéo / audio / data-ANC) et leur machine. Les signaux sont **groupés par machine** : un
  en-tête de machine coiffe ses colonnes (en haut) et ses lignes (à gauche).
- Les filtres *Essence* et *Machine*, la **recherche** et le mode **Câblées uniquement**
  réduisent la matrice quand le parc est grand (voir plus bas).
- L'état de chaque croisement est détecté via IS-05 (`/single/receivers/<id>/active`) : d'abord
  par le `sender_id` renvoyé par le node, sinon par corrélation de l'**adresse multicast:port**
  (repli pour les nodes qui n'exposent pas `sender_id`).
- Une cellule **hachurée** = essences incompatibles (on ne route pas de l'audio sur un receiver
  vidéo). Le point plein ● marque un croisement **complet**.
- L'état est **rafraîchi périodiquement** (léger) ; le bouton **↻** force une relecture immédiate.

## Deux vues : par flux / par signal

La bascule **Vue** change la granularité de la matrice.

- **Par flux** (défaut) : un croisement par signal élémentaire (une vidéo, un canal audio, un
  ANC…). C'est la vue « bas niveau », fidèle aux flux 2110.
- **Par signal** : les signaux d'un même **groupe** sont réunis en **une seule colonne / une
  seule ligne** (libellé = nom du groupe, avec les pastilles des essences contenues, ex.
  `V A ANC`). On ne voit plus qu'**un signal** qui fait à la fois vidéo, audio et ANC.

Le regroupement suit le **Natural Grouping BCP-002-01** :

- **Grouphint** : l'outil lit le tag IS-04 `urn:x-nmos:tag:grouphint/v1.0` de chaque
  ressource. Sa valeur `« <nom du groupe>:<rôle> »` (ex. `SDI 1:VIDEO`) donne le nom du groupe
  et le rôle du signal dedans.
- **Repli heuristique** : si un node ne pose **pas** de grouphint, le groupe est **déduit** du
  **préfixe commun** des libellés d'un même Device, une fois le suffixe d'essence retiré
  (`Vidéo`, `Audio 1`, `ANC`…). Un préfixe partagé par au moins deux signaux forme un groupe,
  signalé discrètement par **≈** (« groupe déduit »). Un signal isolé (sans grouphint ni préfixe
  partageable) reste **affiché seul**.

**La portée d'un nom de groupe est le Device**, jamais le châssis. Un équipement NMOS peut exposer
**plusieurs Devices** — une carte, une direction ou une fonction par Device — et chacun numérote ses
signaux à partir de 1 chez lui : deux « SDI 1 » venus de deux Devices sont **deux signaux
différents**, et la grille leur donne deux lignes. Même chose pour deux cages d'un châssis, qui sont
deux nodes distincts.

Quand deux entrées d'un même châssis portent alors le **même libellé**, celui-ci est préfixé par ce
qui les distingue : le **Device** (`Carte B · SDI 1`), à défaut le nom que le node se donne, à
défaut sa cage. Ce préfixe n'apparaît **qu'en cas d'ambiguïté réelle** — un parc sans homonymes
s'affiche exactement comme avant.

**État d'un croisement groupé** : **complet** (plein ●) si **toutes** les paires d'essences
communes sont routées entre les deux groupes ; **partiel** (hachuré ◐) si **certaines**
seulement ; **vide** sinon.

## Affichage : repli, recherche, câblées, favoris

- **Replier un équipement** — cliquez le chevron **▾/▸** de son en-tête (sources et
  destinations indépendamment). La machine reste visible sous forme d'un **en-tête fin** (une
  seule colonne / ligne) mais ses signaux sont masqués ; un point **●** sur l'en-tête replié
  signale qu'il **cache des croisements actifs**.
- **Recherche** — le champ de la barre filtre **lignes et colonnes en direct** (insensible à la
  casse et aux accents) sur le libellé du signal, le nom du groupe, le nom de la machine et celui
  du **Device**. Une
  machine dont aucun signal ne correspond disparaît ; vider le champ restaure tout.
- **Câblées uniquement** — masque les **destinations sans aucun croisement actif** (en vue par
  signal, un groupe entièrement non routé disparaît).
- **Favoris** — l'**étoile ★** d'un en-tête de machine l'**épingle en tête** de la grille
  (colonnes et lignes) ; les autres suivent dans l'ordre habituel.

Vue, filtres, mode câblées, machines repliées et favoris sont **mémorisés localement**
(navigateur) — la recherche, elle, n'est pas conservée.

## Router un flux (préparer / take)

1. **Cliquer** la cellule à l'intersection de la source voulue et de la destination : elle
   passe en *préparé* et une barre récapitule « destination ◄ source ».
2. **TAKE** (avec confirmation) : le **transportfile SDP** du sender est récupéré via IS-05 et
   appliqué sur le **staged** du receiver (`transport_file` + `activation_mode:
   activate_immediate` + `master_enable: true`). C'est l'équivalent programmatique d'un
   « coller le SDP » et abonner.
3. Pour **déconnecter** une destination, survolez sa ligne et cliquez la croix **✕** à droite
   de son libellé (PATCH `master_enable: false`).

**Take groupé (vue par signal).** Cliquer le croisement de **deux groupes** prépare un take
**groupé** : au TAKE, l'outil **apparie les essences** (vidéo↔vidéo, audio↔audio par rôle/ordre,
ANC↔ANC) et applique les takes **un par un**. Un **rapport** liste chaque paire — ✅ établie,
🔴 en échec, ou ⚪ **sans correspondance** (une essence présente côté destination mais absente
côté source : cette destination reste **inchangée**). La croix **✕** d'une ligne de groupe
déconnecte **tout le groupe**.

> ⚠️ Un TAKE (dés)abonne un équipement **réel** et (re)route un flux multicast ST 2110 sur le
> réseau média. La confirmation avant take est là pour éviter les fausses manœuvres.

## Salvos

Un **salvo** est un ensemble **nommé** de croisements, rejouable d'un clic.

- **+ Depuis le routage courant** capture tous les croisements **actifs** de l'instant.
- **⟳** remplace le contenu d'un salvo par le routage courant ; **Renommer** / **✕** gèrent le
  reste.
- **Appliquer** rejoue chaque croisement du salvo et affiche un **rapport succès / échec par
  croisement** (un croisement fautif n'interrompt pas les autres).

## Snapshots

Un **snapshot** est la **photo du routage complet** courant — chaque destination et sa source,
**déconnexions comprises**. À la différence d'un salvo (sous-ensemble que l'on curate),
**Rappeler** un snapshot ré-applique l'**état exact** capturé : les destinations qui étaient
déconnectées le redeviennent. Idéal pour revenir à une configuration de référence après essais.

## Différence salvo / snapshot

- **Salvo** = liste curée de croisements *à établir* (les autres destinations ne sont pas
  touchées). Pratique pour des « prises » récurrentes (config plateau, config replay…).
- **Snapshot** = état global figé, restitué **à l'identique** (y compris les déconnexions).

> Salvos et snapshots restent au **niveau flux** (croisement par croisement) quelle que soit la
> vue : un take groupé produit des croisements **individuels**, capturés et rejoués comme les
> autres.
