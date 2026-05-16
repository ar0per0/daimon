# Configuración

## Dónde vive la configuración

La configuración principal se guarda en:

```text
data/app-config.json
```

Además, Daimon usa estos recursos:

- `data/regex-rules.json`
- `data/single-pass-ollama-prompt.txt`
- `data/multi-pass-persona-prompt.txt`
- `data/multi-pass-direccion-prompt.txt`
- `data/multi-pass-referencia-prompt.txt`

---

## Cómo configurar Daimon

La forma más sencilla de configurar Daimon es desde:

- `http://localhost:3010/config`

Contraseña inicial del panel:

- `1234`

Cambiar esta contraseña inmediatamente después de la primera entrada.

Desde ese panel se pueden modificar:

- URLs de servicios
- modelos
- reglas regex
- prompts
- opciones de documentos
- opciones RAG
- compatibilidad OpenAI

Los cambios del panel terminan guardándose en los archivos de configuración del proyecto.

Si ejecutas Daimon con Docker, esta configuración quedará persistida en el volumen montado sobre `/app/data`.

Para más detalle sobre RAG, ver [rag.md](./rag.md).
Para más detalle sobre endpoints y compatibilidad OpenAI, ver [api.md](./api.md).

---

## Campos principales

### `configPassword`
Contraseña del panel de configuración.

### `ollamaBaseUrl`
URL base del servicio Ollama usado para saneado local.

Si Ollama corre en otra máquina, esta URL debe apuntar a la IP real y al puerto correcto de esa máquina.

### `ollamaModel`
Modelo local usado para anonimización o chat local directo.

### `proxyBaseUrl`
URL base del servicio remoto compatible con OpenAI.

Si el proxy externo corre en otra máquina, esta URL debe apuntar a la IP real y al puerto correcto de esa máquina.

### `proxyModel`
Modelo remoto usado cuando Daimon llama al proveedor externo.

### `ragEmbedBaseUrl`
URL base del servicio de embeddings para RAG.

### `ragEmbedModel`
Modelo de embeddings para indexación y recuperación.

### `rags`
Lista de definiciones RAG configuradas en el sistema.

Cada RAG puede incluir:

- `key`: clave interna
- `label`: etiqueta visible
- `active`: activación
- `ragOnlyMode`: modo estricto RAG
- `maxFragments`: número máximo de fragmentos

### `documentsEnabled`
Activa o desactiva adjuntos de documentos.

### `publicChatEnabled`
Permite chats públicos además de privados.

### `deepModeEnabled`
Activa la opción visual de modo profundo en la interfaz.

### `openAiCompatEnabled`
Activa los endpoints OpenAI compatibles.

### `openAiCompatApiKey`
Clave requerida para autenticar peticiones a `/v1/*` cuando esa compatibilidad está activa.

### `openAiCompatDebugLogEnabled`
Activa el log de depuración de la capa OpenAI-compatible.

### `openAiCompatDeepModeEnabled`
Activa el modo profundo en la capa OpenAI-compatible.

### `chatMode`
Modo por defecto del chat.

Valores soportados:

- `masked-local-remote`
- `direct-local`
- `direct-remote`

---

## Reglas regex

El archivo `data/regex-rules.json` define patrones de detección inicial.

Cada regla incluye normalmente:

- `name`
- `pattern`
- `flags`
- `label`

Ejemplo conceptual:

```json
{
  "name": "email",
  "pattern": "\\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}\\b",
  "flags": "gi",
  "label": "email"
}
```

Estas reglas forman la primera capa de detección y se pueden adaptar al tipo de datos que quieras proteger.

---

## Prompts de saneado

Daimon soporta al menos dos estrategias:

### Single-pass
Una sola llamada al LLM local para sanear.

Archivo relacionado:

- `data/single-pass-ollama-prompt.txt`

### Multi-pass
Varias pasadas especializadas para distintos tipos de datos o contexto.

Archivos relacionados:

- `data/multi-pass-persona-prompt.txt`
- `data/multi-pass-direccion-prompt.txt`
- `data/multi-pass-referencia-prompt.txt`

Esto permite experimentar con precisión, coste y estabilidad.

---

## Qué conviene revisar primero

Si es la primera vez que configuras Daimon, revisa al menos esto:

- contraseña del panel
- URL base de Ollama
- modelo de Ollama
- URL base del proxy externo
- modelo remoto
- reglas regex
- prompts de saneado
- clave de la API OpenAI-compatible, si la vas a usar

---

## Recomendaciones

- cambia la contraseña por defecto del panel antes de publicar
- no reutilices claves sensibles en ejemplos reales
- separa bien entorno de pruebas y entorno real
- versiona los prompts con cuidado, porque cambian el comportamiento del pipeline
- revisa las reglas regex después de cada cambio importante en los tipos de datos que quieras proteger
- después de cambiar reglas, prompts o modelos, valida el comportamiento desde `http://localhost:3010/debug`
