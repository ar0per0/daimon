# Arquitectura

## Vista general

Daimon está dividido en cuatro piezas principales:

1. **UI web local**
2. **backend Express**
3. **motor de saneado local**
4. **motor de recuperación RAG**

La UI web local incluye principalmente:

- `/` para el chat
- `/config` para configuración
- `/debug` para inspección del flujo

Además, el flujo completo puede depender de dos servicios externos al proceso principal de Daimon:

- **Ollama** para saneado local, chat local y embeddings
- **proxy externo / `openai-oauth`** para conectar con el LLM remoto

---

## Flujo principal

```text
Usuario
  -> UI web
  -> backend Daimon
  -> regex
  -> LLM local
  -> proxy externo / openai-oauth
  -> LLM externo
  -> reconstrucción local
  -> respuesta final al usuario
```

---

## Modos de funcionamiento

La arquitectura cambia ligeramente según el modo activo.

### `masked-local-remote`
Es el modo protegido y el flujo principal recomendado.

Proceso:

1. saneado local
2. envío del texto protegido al remoto
3. reconstrucción local de la respuesta

### `direct-local`
Proceso:

1. el mensaje va directamente al modelo local
2. no se usa el remoto

Aun así, puede seguir usando historial de chat y, si está activo, contexto RAG.

### `direct-remote`
Proceso:

1. el mensaje va directamente al modelo remoto
2. no se aplica saneado local previo

Aun así, puede seguir usando historial de chat y, si está activo, contexto RAG.

Esto es importante porque no todos los caminos de ejecución atraviesan todas las capas.

---

## Pipeline protegido

Esta sección describe el flujo de `masked-local-remote`.

### 1. Entrada del usuario
El mensaje entra desde la UI junto con el `chatId`, el modo de chat y opcionalmente un documento.

### 2. Contexto e historial
Daimon recupera:

- historial visible del chat
- historial enviado al proxy
- mapa de etiquetas (`labelMap`)
- configuración del chat

En esta parte también importa el tipo de acceso del chat:

- los chats privados dependen del navegador que los creó y de su estado local
- los chats públicos se pueden reabrir o compartir con más facilidad

### 3. Extracción de documento
Si hay adjunto, Daimon extrae el texto y lo incorpora al mensaje.

### 4. Recuperación RAG
Si el chat tiene RAG activo:

- busca fragmentos relevantes
- calcula confianza
- añade contexto al prompt
- puede bloquear la respuesta si el modo es estrictamente RAG y no hay suficiente evidencia

### 5. Saneado por regex
Primera pasada rápida para capturar patrones sensibles conocidos.

### 6. Saneado por LLM local
Segunda pasada para:

- refinar detección
- sustituir datos por etiquetas
- mantener consistencia del `labelMap`

`labelMap` es la pieza que relaciona cada etiqueta con su valor privado original y permite reconstruir después la respuesta final.

### 7. Llamada al LLM externo
El backend manda el texto ya saneado al endpoint remoto compatible con OpenAI.

Normalmente esa salida remota pasa por `openai-oauth` o por un proxy equivalente configurado en Daimon.

### 8. Reconstrucción local
La respuesta del remoto se pasa por `deAnonymizeText` para reinsertar el contenido privado correspondiente.

### 9. Persistencia
Se guarda:

- historial visible del usuario
- historial interno del proxy
- mapa de etiquetas actualizado
- ajustes del chat

---

## Qué se guarda y qué sale fuera

Una parte importante de la arquitectura es separar el estado local del contenido enviado al remoto.

### Se guarda localmente

En la parte local del sistema se guarda:

- historial del chat
- historial del lado proxy
- `labelMap`
- configuración del chat
- configuración general
- datos RAG y documentos asociados

Además, el navegador guarda estado local para poder reabrir chats recientes y conservar el acceso práctico a chats privados.

### Sale hacia el remoto

- el texto ya saneado en modo `masked-local-remote`
- el texto original en modo `direct-remote`

Esta diferencia define el nivel de exposición real de cada modo.

---

## Persistencia

### `chat-store.js`
Gestiona el estado por chat en disco:

- `history`
- `proxyHistory`
- `labelMap`
- `access`
- `settings`

### `rag-store.js`
Gestiona el índice RAG con SQLite y `sqlite-vec`:

- documentos
- chunks
- embeddings
- búsqueda léxica
- búsqueda vectorial
- borrado y reindexado

---

## Compatibilidad OpenAI

Daimon expone endpoints compatibles con OpenAI:

- `GET /v1/models`
- `POST /v1/chat/completions`

Eso permite integrarlo como si fuera un backend OpenAI-compatible, mientras el saneado ocurre por debajo.

Según el modo y la configuración, esa capa puede:

- reconstruir contexto de chat
- aplicar saneado local
- usar RAG
- reenviar al remoto o resolver localmente

---

## Seguridad por capas

La arquitectura actual se basa en capas:

1. validación de chat
2. control de acceso por chat público/privado
3. detección regex
4. anonimización con LLM local
5. separación entre historial visible e historial enviado fuera
6. restauración local final

Ese diseño evita que toda la protección dependa de una sola técnica.
