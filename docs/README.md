# Documentación de Daimon

Este directorio contiene la documentación técnica y funcional de Daimon.

El `README.md` principal resume el proyecto. Esta carpeta contiene el detalle técnico.

El `README.md` principal del proyecto explica:

- qué es Daimon
- cuándo usarlo
- cómo arrancarlo rápido con Docker Compose

Este `docs/README.md` sirve como índice para el resto de documentos.

---

## Cómo leer esta documentación

Si quieres entender el proyecto rápido, el orden recomendado es este:

1. [Visión general](./overview.md)
2. [Primeros pasos](./getting-started.md)
3. [Arquitectura](./architecture.md)
4. [Configuración](./configuration.md)
5. [RAG](./rag.md)
6. [Docker](./docker.md)
7. [API](./api.md)

---

## Qué contiene cada fichero

### `overview.md`
Explica qué es Daimon, qué problema resuelve y cuál es su función dentro del flujo local + remoto.

### `getting-started.md`
Explica cómo poner Daimon en marcha y cómo validar que el flujo básico funciona.

### `architecture.md`
Describe las piezas del sistema y el pipeline de saneado, envío remoto y reconstrucción.

### `configuration.md`
Describe archivos, parámetros y piezas configurables del sistema.

### `rag.md`
Describe cómo funciona el sistema RAG, qué tecnología usa y cómo recupera contexto privado.

### `docker.md`
Describe cómo ejecutar Daimon con Docker y Docker Compose.

### `api.md`
Describe los endpoints internos y la capa compatible con OpenAI.

---

## Objetivo de esta documentación

Esta documentación está escrita para que:

- una persona pueda entender el sistema sin contexto previo
- una IA pueda leerlo, inferir el funcionamiento real y aplicarlo sin ambigüedad
- la estructura del proyecto sea fácil de mantener y ampliar

---

## Regla práctica

- usa el `README.md` principal como puerta de entrada rápida
- usa `docs/` cuando necesites detalle técnico o funcional
