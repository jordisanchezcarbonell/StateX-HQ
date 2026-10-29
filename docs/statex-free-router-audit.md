# StateX Free Router: auditoría y propuesta de integración

Fecha: 2026-10-29. Auditoría estática del código local; sin peticiones de inferencia,
lectura de credenciales, cambios al router, instalaciones ni cambios de configuración.

## Decisión

Detener la implementación del proveedor por los bloqueos descritos abajo, conforme
a la restricción de no forzar una integración insegura. La integración es viable
después de endurecer el contrato del router. Actualmente HQ no puede garantizar
`free-only` desde el cliente. Una respuesta con coste cero no demuestra que todos
los intentos y fallbacks estén libres de facturación.

## Arquitectura encontrada

- `src/server/providers.ts`: cuatro proveedores (`claude`, `codex`, `gemini`,
  `openrouter`), detección de motor por ID de modelo, sondeos cacheados, catálogo
  de modelos activos y configuración en `config.json`. Las claves se guardan en
  `secrets.json` con permisos 0600 o se toman del entorno. OpenRouter tiene IDs
  prefijados y usa un endpoint compatible con Anthropic, no Chat Completions.
- `src/server/employee.ts`: concentra colas, turnos, historial, memoria, sesiones
  por chat/tarea, interrupciones, recuperación y reintentos. Claude y OpenRouter
  usan `query()` del Claude Agent SDK. El SDK proporciona el bucle de herramientas
  y sesiones; recibe `cwd`, directorios adicionales, plugins, MCP, instrucciones,
  herramientas permitidas/denegadas y `canUseTool`. Los eventos parciales alimentan
  el streaming de la UI. Los resultados actualizan contexto y coste acumulado.
- Codex y Gemini tienen ejecutores CLI independientes (`codex.ts`, `gemini.ts`),
  streaming de eventos y reanudación de sesiones. No existe un ejecutor genérico
  OpenAI-compatible que pueda reutilizarse directamente.
- El modo de permisos actual admite `bypassPermissions`; Codex lo transforma en
  bypass de aprobaciones y sandbox y Gemini en `yolo`. El nuevo proveedor tendría
  que rechazar este modo explícitamente. `canUseTool` es una capa de aprobación,
  no debe confundirse con un aislamiento del sistema operativo.
- `src/server/index.ts`: APIs de proveedores y modelos activos para el cliente;
  escucha local por defecto pero permite acceso remoto con un override explícito.
  `web/settings.js` renderiza proveedores y `web/employee.js` consume los modelos.

## Router real y bloqueos

1. `free-model-router/main.py`, `POST /v1/chat/completions`: elimina `model` del
   payload y vuelve a elegir todos los candidatos. No expone política por petición,
   restricción verificable de proveedores o catálogo con precios y capacidades.
   `GET /health` sólo devuelve `status: ok`; no acredita una configuración segura.
2. `router/model_router.py`: OpenRouter exige `:free` y precios de prompt y
   completion iguales a la cadena `"0"`, con caché de 300 s por defecto. Es mejor
   que comprobar únicamente el nombre, pero no verifica otras dimensiones de
   precio ni fuerza un límite de precio en la petición al proveedor.
3. `adapters/groq.py`: descubre modelos por ventana de contexto y máximo de salida.
   No verifica precios, cuotas o modalidad de facturación de la cuenta. No hay
   evidencia suficiente en este contrato para certificar Groq como gratuito.
4. `router/failover.py`: recorre adaptadores/modelos y finalmente el proveedor
   local. Los errores genéricos, incluido 402, permiten continuar. No hay un filtro
   global de coste independiente del adaptador ni clasificación propia de 402.
5. En streaming, el mismo failover puede continuar tras emitir fragmentos. Puede
   mezclar respuestas o argumentos de herramientas de distintos intentos. Los
   errores terminales también pueden llegar dentro de SSE con estado HTTP 200.
6. OpenRouter y Groq incluyen fragmentos del cuerpo de error remoto en excepciones;
   el router los propaga o registra. No hay una sanitización central que garantice
   ausencia de secretos o datos sensibles procedentes de esos cuerpos.
7. Groq transforma `tool_choice` en `auto` cuando hay herramientas, salvo `none`.
   Por tanto no conserva la semántica de selección obligatoria o función concreta.
   La comprobación de soporte de herramientas del arranque sólo cubre OpenRouter.
8. El arranque verifica herramientas mediante inferencias reales. No se debe
   iniciar el router para ejecutar pruebas offline. `run.sh` también sincroniza
   dependencias, puede crear `.env` y mata procesos del puerto; no se ejecutó.
   Su bind por defecto es local, pero `SERVER_HOST` puede cambiarlo.

## Opciones evaluadas

| Opción | Ventaja | Limitaciones y riesgos |
| --- | --- | --- |
| Adaptador local Anthropic Messages ↔ Chat Completions | Conserva SDK, herramientas, MCP y sesiones | Traducción de bloques, tool IDs/resultados, stop reasons, tokens, errores, cancelación y SSE. Debe rechazar capacidades no soportadas; requiere pruebas reales de compatibilidad del SDK. No resuelve por sí mismo los costes del router. |
| Ejecutor OpenAI-compatible nativo | Habla directamente con la API actual | Obliga a implementar y mantener bucle de herramientas, permisos, sandbox, sesiones, compactación y recuperación. Demasiada superficie para este MVP. |
| Chat sin herramientas | Menor desarrollo | Incumple preservar las herramientas de los empleados; descartado. |
| Endpoint Anthropic en el router con política obligatoria | Reutiliza el ejecutor de HQ y centraliza las garantías | Requiere modificar primero el router y validar el contrato completo; opción recomendada para una siguiente implementación. |

No basta cambiar `ANTHROPIC_BASE_URL`: el router no implementa Messages API.
La recomendación es condicional a superar los tests de protocolo y permisos del
SDK; no se afirma compatibilidad basándose sólo en los formatos de chat.

## Cambios mínimos propuestos antes de implementar

Es necesario modificar el router porque HQ no controla los candidatos que el
servidor selecciona y descubre el coste sólo después de una posible facturación.
No se ha modificado ningún archivo de `free-model-router`.

- Política de servidor `free-only`, obligatoria y no relajable por el payload:
  permitir sólo candidatos con evidencia de precio cero para todas las dimensiones
  facturables aplicables; rechazar datos ausentes, inválidos o caducados. Validar
  contra catálogo de OpenRouter y restringir precios en la solicitud usando las
  capacidades documentadas del proveedor. Verificar ese contrato antes de codificarlo.
- Excluir Groq inicialmente hasta disponer de evidencia verificable de la modalidad
  gratuita y de que no existe desbordamiento hacia facturación. Excluir también
  otros proveedores no acreditados. Ninguna ampliación automática de esa lista.
- 429: fallback acotado únicamente dentro del conjunto verificado; cooldown por
  proveedor y modelo. 402: error de política/facturación terminal, sin fallback.
  Sin candidatos: 503 controlado. Nunca degradar a un modelo de pago.
- Hacer failover sólo antes del primer evento de respuesta; después, terminar el
  stream con error controlado sin concatenar otro intento. Preservar tool calls,
  resultados correlacionados y semántica de `tool_choice` o rechazarla explícitamente.
- Endpoint de capacidades/política sin secretos, y metadatos estructurados por
  intento: ID de petición, proveedor, modelo efectivo, estado y evidencia de precio.
  Rechazar un coste reportado distinto de cero como violación, entendiendo que esa
  comprobación posterior sirve de alarma y no previene la facturación por sí sola.
- Sanitizar errores antes de registrarlos o enviarlos. No registrar cabeceras,
  claves, payloads, cuerpos remotos ni credenciales del entorno.
- Añadir Messages API y SSE compatibles con las funciones del SDK utilizadas por
  HQ, incluyendo respuestas a herramientas, cancelación y límites de tamaño/tiempo.
- En HQ: proveedor `statex-free-router`, modelo lógico prefijado para selección
  automática y URL `STATEX_FREE_ROUTER_URL` (propuesta), valor por defecto
  `http://127.0.0.1:4141`. Validar dirección IP de loopback literal, sin credenciales,
  query ni fragmento; desactivar redirects. Bind local obligatorio en ambos servicios
  cuando se use este proveedor, incluso con overrides de acceso remoto existentes.
- Reutilizar permisos y sesiones del SDK, rechazar bypass y configuraciones de
  herramientas que eludan aprobación; comprobar el aislamiento de procesos y los
  límites efectivos de directorios. No heredar claves de otros proveedores hacia
  el adaptador. Mantener Claude, Codex, Gemini y OpenRouter en sus rutas actuales.
- No se necesita migrar persistencia: reutilizar `providers` e IDs prefijados,
  guardar modelo efectivo como actividad y mantener el modelo lógico seleccionado.

## Validación prevista y estado

No se han implementado ni ejecutado tests del nuevo proveedor porque se ha detenido
su implementación. No se ha probado conexión con el proceso de 4141, inferencia,
tool calling ni streaming real. No se han usado credenciales ni proyectos reales.

Antes de habilitarlo, usar servidores simulados en loopback y herramientas inertes:

| Prueba | Criterio de aceptación |
| --- | --- |
| Conexión | Health y capacidades válidos; timeout, redirect y URL remota rechazados |
| Chat | Conversión Messages correcta, modelo efectivo registrado, sin claves |
| Herramientas | Llamada → aprobación → resultado → respuesta; IDs conservados; denegación impide ejecución |
| Streaming | Fragmentación arbitraria SSE y argumentos JSON, cancelación, errores HTTP y SSE |
| 429 | Fallback sólo antes de emitir y entre candidatos gratuitos verificados |
| 402 / sin modelos | Error terminal sanitizado / 503; ninguna inferencia posterior |
| Costes | Rechazar precios positivos, desconocidos, caducados y sufijos `:free` con precio positivo |
| Permisos | Rechazar bypass y rutas fuera de directorios autorizados; no ejecutar shell real |
| Regresión | Detección, selección, entorno y sesiones de los cuatro proveedores existentes intactos |

## Ejecución

El nuevo proveedor todavía no está disponible: establecer la variable propuesta
no lo activa. La ejecución actual de HQ permanece sin cambios (`npm run dev`).
Tras implementar y validar el contrato anterior, el comando previsto sería:

```sh
STATEX_FREE_ROUTER_URL=http://127.0.0.1:4141 npm run dev
```

Entonces se seleccionaría StateX Free Router en la configuración de modelos y del
empleado. No cambiar `.env` ni utilizar claves para el health check. Las pruebas
de inferencia reales requerirán autorización expresa del usuario.
