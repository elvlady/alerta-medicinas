# Alerta Medicinas

App rapida para recordatorios de medicinas hecha con Bun, SQLite3 y Web Push. Esta pensada para desplegarse desde GitHub en EasyPanel usando el `Dockerfile` incluido.

## Stack

- Bun como servidor HTTP.
- SQLite3 con `bun:sqlite`.
- Web Push con VAPID.
- Datos persistentes en `/app/data`.

## Desarrollo local

```bash
bun install
bun run dev
```

Abre:

```txt
http://127.0.0.1:3000
```

En el primer acceso la app pide crear el usuario admin.

## Variables

```ini
PORT=3000
DATA_DIR=/app/data
APP_TIMEZONE=America/Mazatlan
VAPID_SUBJECT=mailto:admin@example.com
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
ADMIN_USERNAME=
ADMIN_PASSWORD=
ADMIN_NAME=
```

Las llaves VAPID son opcionales. Si no las configuras, la app las genera y las guarda en SQLite. En produccion, monta `/app/data` como volumen para no perder usuarios, medicinas, sesiones, suscripciones push ni llaves VAPID.

`ADMIN_USERNAME` y `ADMIN_PASSWORD` tambien son opcionales. Si los defines, la app crea ese admin o actualiza su contrasena al arrancar. Esto sirve para recuperar acceso si olvidaste la contrasena guardada en SQLite.

## Docker

```bash
docker build -t alerta-medicinas .
docker run --rm -p 3000:3000 -v alerta-medicinas-data:/app/data alerta-medicinas
```

## EasyPanel

1. Crea una app nueva desde GitHub.
2. Selecciona este repositorio.
3. Tipo de build: Dockerfile.
4. Puerto interno: `3000`.
5. Agrega volumen persistente:

```txt
/app/data
```

6. Agrega variables:

```ini
APP_TIMEZONE=America/Mazatlan
VAPID_SUBJECT=mailto:tu-correo@tudominio.com
ADMIN_USERNAME=zeus
ADMIN_PASSWORD=una-contrasena-larga
```

7. Publica con HTTPS.

Web Push necesita HTTPS en dominio real. En `localhost` funciona para pruebas, pero en produccion usa el dominio que EasyPanel te da o tu propio dominio con SSL.
