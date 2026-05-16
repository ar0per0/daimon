# API

## Resumen

Daimon expone dos grupos de endpoints:

1. **API interna de la aplicación web** (`/api/*`)
2. **API compatible con OpenAI** (`/v1/*`)

---

## Cómo interpretar esta API

No todos los endpoints tienen el mismo propósito.

### `/api/*`
Esta API está pensada principalmente para la interfaz web de Daimon.

Sirve para:

- salud del sistema
- configuración
- historial
- chat
- RAG
- panel de administración

Debe entenderse como una API interna del producto.

### `/v1/*`
Esta API está pensada para clientes externos compatibles con OpenAI.

Sirve para:

- usar Daimon como capa intermedia
- conectar SDKs o clientes ya existentes
- aprovechar el pipeline de Daimon desde software externo

---

## Endpoints internos

### Salud y configuración

- `GET /api/health`
- `GET /api/config`
- `GET /api/proxy-health`
- `GET /api/ollama-health`
- `GET /api/rag-embed-health`

### Autenticación del panel

- `POST /api/config-auth/verify`
- `GET /api/config-auth/status`
- `POST /api/config-auth/logout`

### Gestión de configuración

- `GET /api/config-data`
- `POST /api/config-data/password`
- `POST /api/config-data/ollama`
- `POST /api/config-data/proxy`
- `POST /api/config-data/rag-embed`
- `POST /api/config-data/single-pass-prompt`
- `POST /api/config-data/regex-rules`
- `POST /api/config-data/multi-pass-prompts`
- `POST /api/config-data/documents`
- `POST /api/config-data/openai-compat`
- `POST /api/config-data/rags`
- `POST /api/config-data/rags/:ragKey`
- `GET /api/config-data/rag/files`
- `POST /api/config-data/rag/revectorize-all`
- `POST /api/config-data/rag/upload`

### Historial y chats

- `GET /api/history`
- `POST /api/history/clear`
- `POST /api/chat/settings`
- `POST /api/chat`

---

## `POST /api/chat`

Es el endpoint principal del producto.

### Qué hace

- recibe el mensaje del usuario
- opcionalmente procesa un documento adjunto
- recupera historial y `labelMap`
- aplica pipeline protegido o directo según el modo activo
- puede recuperar contexto RAG
- devuelve eventos NDJSON durante la ejecución

### Parámetros importantes

Acepta como mínimo:

- `message`: texto del usuario

También puede recibir:

- `document`: archivo adjunto
- `singlePass=true`: para usar la estrategia single-pass de saneado

`singlePass` puede enviarse por body o query.

### Contexto del chat

El backend usa información de chat que puede llegar por cabeceras, query o body.

Campos relevantes:

- `x-chat-id`
- `x-chat-access`
- `x-chat-secret`

Esto permite:

- identificar la conversación
- distinguir chats públicos y privados
- proteger el acceso al historial de cada chat

### Formato de respuesta

La respuesta no es un JSON único.

Devuelve una secuencia de eventos NDJSON con este content-type:

```text
application/x-ndjson
```

Cada línea es un JSON independiente.

Ejemplos de eventos:

- `start`
- `document`
- `rag-context`
- `proxy-start`
- `proxy-done`
- `complete`
- `error`

También pueden aparecer eventos de modos directos, por ejemplo:

- `local-direct-start`
- `local-direct-done`
- `remote-direct-start`
- `remote-direct-done`

Eso permite enseñar trazas, progreso y estado del pipeline en tiempo real en la UI.

### Ejemplo mínimo de `/api/chat`

```bash
curl -X POST http://localhost:3010/api/chat \
  -H "X-Chat-Id: demo1234" \
  -H "X-Chat-Access: public" \
  -F 'message=Mi nombre es Ana López y mi DNI es 12345678Z. Redáctame un mensaje formal.'
```

---

## API OpenAI-compatible

### `GET /v1/models`
Devuelve el modelo virtual expuesto por Daimon.

### `POST /v1/chat/completions`
Acepta payloads compatibles con OpenAI Chat Completions.

Esto permite usar Daimon como backend intermedio desde clientes ya existentes.

Si quieres mantener contexto por conversación desde un cliente externo, puedes enviar también `x-chat-id`.

### Autenticación

La API `/v1/*` requiere autenticación si la compatibilidad OpenAI está activa.

Normalmente se usa:

```text
Authorization: Bearer TU_API_KEY
```

La clave se configura en Daimon.

### Streaming

`POST /v1/chat/completions` soporta peticiones con `stream=true`.

Esto permite integrar clientes que esperan respuestas en streaming al estilo OpenAI.

### Compatibilidad probada

La API OpenAI-compatible de Daimon se ha probado con <https://openwebui.com/> y funciona bien.

---

## Ejemplo mínimo

```bash
curl http://localhost:3010/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TU_API_KEY" \
  -d '{
    "model": "daimon",
    "messages": [
      {"role": "user", "content": "Escribe un resumen de este texto"}
    ]
  }'
```

---

## Cuándo usar cada API

Usa `/api/*` si:

- estás trabajando con la interfaz web de Daimon
- necesitas configurar el sistema
- quieres consultar historial, RAG o estado interno

Usa `/v1/*` si:

- quieres conectar una app externa
- ya usas clientes compatibles con OpenAI
- quieres que Daimon actúe como pasarela intermedia

---

## Seguridad

Si activas la compatibilidad OpenAI:

- protege bien la API key
- no expongas el servicio sin control de red
- revisa si el modo usado es protegido o remoto directo
- recuerda que la seguridad real depende del pipeline configurado

