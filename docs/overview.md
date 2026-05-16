# Visión general

## Qué es Daimon

Daimon es un software local que actúa como intermediario entre un usuario y uno o varios LLM.

Su objetivo principal es **proteger datos sensibles antes de enviar una petición a un modelo externo**.

En lugar de mandar el texto original tal cual, Daimon aplica un pipeline de saneado local:

- detección por regex
- anonimización/refinado con un LLM local
- sustitución por etiquetas estables
- envío del texto protegido al modelo remoto
- reconstrucción local del contenido privado en la respuesta final

---

## Problema que resuelve

Los LLM externos suelen dar mejores respuestas, pero también implican un riesgo claro:

- el prompt puede contener datos privados
- esos datos pueden incluir datos personales (PII), credenciales o contenido interno
- una fuga aquí no es un bug visual, es un problema de seguridad

Daimon se coloca justo en medio para minimizar esa exposición.

---

## En una frase

**Daimon usa privacidad local para aprovechar inteligencia externa con menos riesgo.**

---

## Componentes principales

### Frontend web
Interfaz local para chatear, configurar el pipeline y gestionar fuentes RAG.

### Backend Express
Coordina el flujo completo: historial, saneado, llamadas a Ollama, proxy externo, reconstrucción y compatibilidad OpenAI.

### Reglas regex
Primera capa de detección rápida para patrones sensibles conocidos.

### LLM local
Segunda capa de saneado. Mejora la anonimización cuando las regex no bastan o no capturan bien el contexto.

### LLM externo
Modelo más potente para generar la respuesta final a partir del texto ya protegido.

### RAG privado
Permite consultar documentos privados y añadir fragmentos relevantes al contexto sin exponer la base documental completa.

---

## Qué datos puede detectar

La configuración actual incluye ejemplos como:

- DNI
- NIE
- CIF
- email
- IBAN
- teléfonos
- tarjetas de pago
- CVV y caducidad
- matrículas
- tokens y claves frecuentes
- JWT

Estas reglas son configurables.

---

## Qué no promete

Daimon no debe venderse como seguridad perfecta.

Hay límites reales:

- una regex puede no detectar todo
- un LLM local puede fallar o reinterpretar mal algo
- una restauración mal diseñada puede introducir errores
- un prompt complejo puede contener sensibilidad contextual difícil de clasificar

Por eso Daimon debe entenderse como una **capa de reducción de riesgo**, no como una garantía absoluta.
