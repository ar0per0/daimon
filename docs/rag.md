# RAG

## Qué es el RAG en Daimon

En Daimon, RAG se usa para añadir contexto privado a una consulta antes de generar la respuesta.

La idea es simple:

1. el usuario hace una pregunta
2. Daimon busca fragmentos relevantes dentro de una base documental privada
3. esos fragmentos se añaden al contexto de la consulta
4. el modelo responde usando ese material como apoyo

Esto permite responder con información propia sin tener que meter manualmente todo el contenido en cada prompt.

---

## Para qué sirve

El RAG de Daimon encaja bien si quieres:

- consultar documentos privados
- responder preguntas usando información interna
- limitar la respuesta a una base documental concreta
- reducir alucinaciones cuando existe una fuente privada de referencia
- separar el conocimiento privado del prompt principal del usuario

---

## Tecnología usada

El sistema RAG actual se apoya en estas piezas:

- **SQLite** para persistencia local
- **sqlite-vec** para búsqueda vectorial
- **FTS5** de SQLite para búsqueda léxica
- **Ollama** o un servicio compatible para generar embeddings
- **backend Express** para coordinar indexación, búsqueda y envío al pipeline principal

---

## Componentes principales

### `rag-store.js`
Gestiona la capa de persistencia y búsqueda RAG.

Responsabilidades principales:

- crear y mantener la base de datos RAG
- guardar documentos
- dividir documentos en chunks
- guardar embeddings
- buscar por similitud vectorial
- buscar por coincidencia léxica
- combinar resultados
- borrar documentos o índices completos

### Carpeta `data/rag/`
Contiene el estado persistente del RAG.

Aquí viven, según el uso:

- bases de datos SQLite
- documentos subidos
- índices asociados

### Panel `/config`
Permite:

- configurar el modelo de embeddings
- configurar la URL del servicio de embeddings
- crear grupos RAG
- activar o desactivar fuentes
- subir documentos `.txt`
- revectorizar documentos

Ruta útil:

- `http://localhost:3010/config`

---

## Cómo funciona el proceso RAG

### 1. Definición de una fuente RAG

Daimon trabaja con definiciones RAG dentro de la configuración.

Cada fuente RAG puede incluir:

- `key`: identificador interno
- `label`: nombre visible
- `active`: si está activa o no
- `ragOnlyMode`: si la respuesta debe depender estrictamente del RAG
- `maxFragments`: máximo de fragmentos recuperados para el prompt

---

### 2. Subida de documentos

Los documentos se suben desde `/config`.

El flujo actual está orientado sobre todo a documentos de texto.

Actualmente el RAG solo acepta archivos:

- `.txt`

Cuando un documento entra en el sistema:

1. se guarda localmente
2. se registra como documento RAG
3. se divide en fragmentos o chunks
4. cada chunk se prepara para indexación

---

### 3. Generación de embeddings

Cada chunk se convierte en un embedding usando el modelo configurado en:

- `ragEmbedBaseUrl`
- `ragEmbedModel`

Ese embedding permite hacer búsqueda semántica por similitud.

---

### 4. Indexación

Después de generar embeddings, Daimon guarda:

- metadatos del documento
- texto de cada chunk
- embeddings de cada chunk

Esto deja preparado el índice para búsquedas posteriores.

---

### 5. Búsqueda cuando llega una pregunta

Cuando el usuario envía un mensaje y el chat tiene un RAG activo:

1. Daimon toma la consulta
2. calcula recuperación RAG sobre esa consulta
3. busca candidatos por similitud vectorial
4. busca candidatos por coincidencia léxica
5. combina resultados
6. calcula una señal de confianza
7. selecciona los mejores fragmentos

---

### 6. Construcción del contexto

Los fragmentos elegidos se convierten en un bloque de contexto adicional.

Ese bloque se añade al mensaje que seguirá el pipeline principal.

Dependiendo del modo, la respuesta final puede:

- usar el RAG como apoyo para enriquecer la respuesta
- depender estrictamente del RAG si `ragOnlyMode` está activo

---

### 7. Control por confianza

Daimon no usa siempre cualquier resultado RAG sin criterio.

El sistema evalúa la calidad de la recuperación.

Si el RAG está en modo estricto y la confianza es baja:

- puede devolver una respuesta de fallback
- puede evitar seguir con una respuesta inventada o poco apoyada en la fuente privada

Ejemplo de respuesta de fallback:

```text
No encuentro información suficiente en la fuente privada seleccionada para responder a esa consulta.
```

Esto es importante para reducir respuestas débiles o alucinadas cuando el material recuperado no es suficiente.

---

## Tipos de búsqueda

### Búsqueda vectorial

Busca chunks por cercanía semántica usando embeddings.

Sirve para recuperar texto relacionado aunque no repita exactamente las mismas palabras.

### Búsqueda léxica

Busca chunks por coincidencia de términos usando FTS.

Sirve para recuperar texto cuando ciertas palabras exactas son importantes.

### Búsqueda híbrida

Daimon combina ambas señales.

Esto mejora la recuperación porque:

- la vectorial aporta significado
- la léxica aporta precisión sobre términos concretos

---

## Qué controla el resultado final

La calidad del RAG depende de varios factores:

- calidad del texto subido
- tamaño y corte de chunks
- calidad del modelo de embeddings
- calidad de la consulta del usuario
- configuración de `maxFragments`
- modo estricto o no estricto

---

## Relación con el resto del pipeline

El RAG no sustituye el saneado ni el control de privacidad.

Encaja antes de la generación final de respuesta.

En el modo protegido típico:

1. Daimon recibe el mensaje
2. recupera contexto RAG si corresponde
3. construye el mensaje ampliado
4. sanea el contenido sensible
5. envía la versión protegida al remoto
6. reconstruye la respuesta final

---

## Qué se guarda en local

El sistema RAG guarda en local:

- documentos
- chunks
- embeddings
- metadatos
- índices SQLite

Esto significa que la base documental privada permanece en el entorno local de Daimon, salvo que el usuario decida otra arquitectura.

---

## Limitaciones prácticas

Conviene entender estos límites:

- si el documento está mal estructurado, la recuperación empeora
- si el modelo de embeddings no es bueno para ese dominio, la búsqueda semántica empeora
- si la consulta del usuario es muy vaga, el contexto recuperado puede ser débil
- si `maxFragments` es demasiado bajo, puede faltar contexto
- si es demasiado alto, el prompt puede meter ruido

---

## Cuándo revisar `/debug`

Revisar `http://localhost:3010/debug` cuando quieras comprobar:

- qué fragmentos se han recuperado
- cuánta confianza tiene la recuperación
- si se ha aplicado fallback
- cómo ha quedado el mensaje antes de salir al remoto

---

## Recomendaciones

- crear fuentes RAG separadas por tema o dominio
- subir documentos limpios y bien estructurados
- revisar resultados con preguntas reales
- ajustar `maxFragments` según el tipo de consulta
- usar `ragOnlyMode` cuando quieras limitar la respuesta estrictamente a la base documental
- revectorizar si cambias el modelo de embeddings
- revectorizar también si cambias de forma importante la estrategia de documentos o regeneras la base documental
