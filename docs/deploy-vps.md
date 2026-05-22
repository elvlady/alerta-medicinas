# EasyPanel con Bun, SQLite3 y push

Esta app esta lista para importarse desde GitHub en EasyPanel. El contenedor usa Bun, guarda SQLite en `/app/data` y manda recordatorios push desde el mismo proceso.

## 1. Publicar en GitHub

Primero inicia sesion localmente:

```bash
gh auth login
```

Luego crea el repositorio publico y sube el proyecto:

```bash
git remote rename origin upstream
git add .gitignore .dockerignore .env.example Dockerfile README.md package.json bun.lock src public docs/deploy-vps.md
git commit -m "Prepare Bun SQLite medicine reminders"
gh repo create alerta-medicinas --public --source . --remote origin --push
```

Si ya tienes remoto:

```bash
git remote add origin https://github.com/TU_USUARIO/alerta-medicinas.git
git push -u origin master
```

## 2. Crear app en EasyPanel

1. Crea `New App`.
2. Elige `GitHub`.
3. Selecciona el repo `alerta-medicinas`.
4. Build: `Dockerfile`.
5. Puerto interno: `3000`.
6. Activa HTTPS en el dominio.

## 3. Volumen persistente

Agrega un volumen:

```txt
/app/data
```

Esto guarda:

- SQLite.
- Usuarios.
- Medicinas.
- Suscripciones push.
- Llaves VAPID si se generan automaticamente.

## 4. Variables recomendadas

```ini
PORT=3000
DATA_DIR=/app/data
APP_TIMEZONE=America/Chihuahua
VAPID_SUBJECT=mailto:admin@tudominio.com
```

`VAPID_PUBLIC_KEY` y `VAPID_PRIVATE_KEY` son opcionales. Si las dejas vacias, la app las crea sola y las guarda en SQLite.

## 5. Probar

1. Abre tu dominio.
2. Crea el admin inicial.
3. Agrega una medicina con la hora del minuto siguiente.
4. Pulsa `Activar` en Push y acepta permisos.
5. Pulsa `Probar` para validar que el navegador recibe notificaciones.

Si no aparece el permiso de notificaciones, revisa que el sitio este en HTTPS y que el navegador no tenga bloqueado ese dominio.
