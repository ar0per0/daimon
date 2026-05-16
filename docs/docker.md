# Docker

## Imagen

Daimon puede ejecutarse como contenedor Docker y está publicado en Docker Hub:

- <https://hub.docker.com/r/ar0per0/daimon>

Imagen:

```text
ar0per0/daimon:latest
```

Daimon suele trabajar junto con este servicio relacionado:

- `openai-oauth`: <https://hub.docker.com/r/ar0per0/openai-oauth>

---

## Construir localmente

Si quieres construir la imagen localmente, primero descarga o clona el proyecto y entra en su carpeta:

```bash
git clone https://github.com/ar0per0/daimon.git
cd daimon
```

Después construye la imagen:

```bash
docker build -t daimon:latest .
```

---

## Ejecutar con `docker run`

Este ejemplo levanta solo Daimon.

```bash
docker run -d \
  --name daimon \
  -p 3010:3010 \
  -v daimon:/app/data \
  --restart unless-stopped \
  ar0per0/daimon:latest
```

Esto:

- publica el puerto `3010`
- persiste datos en `/app/data`
- reinicia el contenedor automáticamente salvo parada manual

Si quieres el flujo completo habitual, además tendrás que tener disponible `openai-oauth` y el servicio Ollama.

---

## Ejecutar con Docker Compose

Ejemplo completo con `openai-oauth` y `daimon`:

```yaml
services:
  openai-oauth:
    container_name: openai-oauth
    image: ar0per0/openai-oauth
    restart: unless-stopped
    ports:
      - "10531:10531"
    volumes:
      - openai-oauth:/data

  daimon:
    container_name: daimon
    image: ar0per0/daimon:latest
    restart: unless-stopped
    ports:
      - "3010:3010"
    volumes:
      - daimon:/app/data

volumes:
  openai-oauth:
  daimon:
```

Arranque:

```bash
docker compose up -d
```

Validación rápida:

```bash
docker ps
```

Deberían aparecer al menos estos contenedores en ejecución:

- `openai-oauth`
- `daimon`

Parada:

```bash
docker compose down
```

Si `openai-oauth` necesita autenticarse con el proveedor externo, consulta sus logs:

```bash
docker logs openai-oauth
```

---

## Volúmenes

Daimon guarda información persistente en `data/`.

Montar `/app/data` como volumen permite conservar:

- configuración del panel
- historial de chats
- índices RAG
- documentos subidos

Sin ese volumen, esos datos se perderían al recrear el contenedor.

---

## Variables de entorno

El contenedor usa por defecto:

- `NODE_ENV=production`
- `PORT=3010`

Además puedes sobrescribir otras variables soportadas por la app, por ejemplo:

- `EXTERNAL_LLM_BASE_URL`
- `EXTERNAL_LLM_MODEL`
- `OLLAMA_BASE_URL`
- `OLLAMA_MODEL`
- `RAG_EMBED_BASE_URL`
- `RAG_EMBED_MODEL`

Muchas opciones también se pueden configurar desde `http://localhost:3010/config`, sin necesidad de redefinir variables de entorno en el contenedor.

---

## Nota importante

Docker empaqueta Daimon, pero no elimina dependencias externas del flujo.

Si tu pipeline depende de:

- un Ollama en otra máquina
- un proxy local externo
- un endpoint remoto concreto

esas piezas deben seguir accesibles desde el contenedor.

Si Ollama o el proxy externo corren en otra máquina, el contenedor de Daimon debe poder acceder por red a esa IP y a su puerto correspondiente.
