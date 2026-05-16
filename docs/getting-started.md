# Primeros pasos

## Requisitos

Antes de arrancar Daimon necesitas:

- Node.js 22 o compatible
- un servicio Ollama accesible para el saneado local
- un endpoint externo compatible con OpenAI para el modelo remoto

Por defecto el proyecto usa:

- Ollama: `http://192.168.1.154:11434`  
  Cambiar esta IP por la IP real de la máquina donde Ollama esté corriendo.
- proxy externo: `http://192.168.1.160:10531/v1`  
  Cambiar esta IP por la IP real de la máquina donde el proxy externo esté corriendo.

Daimon se puede ejecutar:

- en local con Node.js
- con Docker y Docker Compose

Para la ejecución con Docker y Docker Compose, ver [docker.md](./docker.md).

Para más detalle sobre parámetros y archivos, ver [configuration.md](./configuration.md).

---

## Instalación local

```bash
cd /ruta/daimon
npm install
npm start
```

Luego abre:

```text
http://localhost:3010
```

---

## Flujo mínimo recomendado

1. abre `http://localhost:3010/config` e inicia sesión con la contraseña inicial `1234`
2. revisa la URL de Ollama y del proxy externo
3. revisa el modelo local y el remoto
4. para la primera prueba usa primero el modo `masked-local-remote`
5. envía un mensaje con datos fácilmente identificables
6. verifica en `http://localhost:3010/debug` qué sale del lado local y qué se envía fuera
7. si todo ha ido bien, `/config` debe cargar correctamente y `/debug` debe mostrar actividad cuando envíes mensajes

---

## Primer test útil

Prueba algo como esto:

```text
Mi nombre es Ana López, mi correo es ana@example.com y mi DNI es 12345678Z. Redáctame un mensaje formal para pedir una cita.
```

Lo esperable es:

- el texto original se sanea localmente
- el LLM externo no ve los datos reales
- la respuesta final del usuario vuelve reconstruida

Si el texto sensible sigue saliendo sin sanear en `/debug`, revisar reglas regex, prompts y modo activo.

---

## Modos disponibles

Daimon permite cambiar el modo de funcionamiento para adaptarse al estado de los servicios.

Esto es útil, por ejemplo, si uno de los dos lados falla temporalmente:

- si el modelo externo o el proxy no están disponibles, se puede seguir operando con el modelo local
- si el modelo local no está disponible, se puede pasar al modo remoto directo si se prefiere seguir operando

### Modo protegido
`masked-local-remote`

Usa saneado local + LLM remoto.

### Modo local
`direct-local`

Todo pasa por Ollama.

### Modo remoto directo
`direct-remote`

Manda el texto tal cual al modelo externo.

---

## Chats privados y públicos

Por defecto, los chats nuevos son **privados**.

Eso implica:

- solo se pueden volver a abrir desde el navegador donde fueron creados
- el acceso depende del estado local guardado en ese navegador
- si abres Daimon desde otro navegador, ese chat privado no será accesible automáticamente

Si quieres compartir un chat o abrirlo desde otro navegador, hay que convertirlo en **público** desde la interfaz.

Daimon incluye un botón para hacer público un chat cuando esa opción está habilitada en la configuración.

### Historial local del navegador

La lista de chats recientes y el acceso local a chats privados se guarda en el navegador.

Esto significa que:

- si borras almacenamiento local, temporales o datos del navegador, puedes perder el acceso práctico a esos chats privados
- si cambias de navegador, tampoco tendrás acceso automático a esos chats privados
- los chats públicos sí se pueden volver a abrir o compartir con más facilidad

---

## Configuración inicial importante

Revisa especialmente estos campos:

- contraseña del panel de configuración
- URL base de Ollama
- modelo de Ollama
- URL base del proxy externo
- modelo remoto
- reglas regex
- prompts de saneado

---

## Fallos comunes

- si el remoto no responde, revisar `openai-oauth` o el proxy externo
- si el local no responde, revisar Ollama
- si no ves trazas del flujo, revisar `http://localhost:3010/debug`

---

## Consejos para la primera puesta en marcha

- empieza con casos fáciles y observables
- prueba datos personales y también tokens o claves simuladas
- compara respuesta en modo protegido vs remoto directo
- revisa el comportamiento con documentos adjuntos
- no expongas el backend directamente a internet sin una capa adicional
