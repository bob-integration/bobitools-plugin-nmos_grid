# SPDX-License-Identifier: GPL-3.0-or-later
# Image autonome de l'outil « Grille NMOS ». requests pour parler au NMOS des équipements
# (IS-04 / IS-05, HTTP clair) : énumération des senders/receivers et TAKE via PATCH staged.
FROM python:3.13-slim

RUN pip install --no-cache-dir requests

WORKDIR /app
COPY server.py nmos.py /app/

# /data : nodes manuels, salvos, snapshots, état du routage simulé.
# /bmd (ro) : parc de convertisseurs de bmd_nmos (inventaire source de la grille).
VOLUME ["/data"]

# Port HTTP interne — DOIT correspondre à docker.port du plugin.json.
EXPOSE 8080

CMD ["python", "-u", "/app/server.py"]
