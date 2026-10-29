# Evaluación de OmniRoute para StateX Free Agent

Fecha: 2026-10-29. Checkout evaluado fuera del repositorio: `/private/tmp/statex-omniroute-eval/omniroute`, versión `3.6.1`, commit `515674b`.

## Veredicto

**NO-GO como gateway de inferencia para Mia por ahora.** OmniRoute ofrece una API OpenAI-compatible que encaja en forma con Free Agent, pero hoy no tenemos una señal verificable de política `free-only`, ni podemos verificar las cuotas o condiciones de facturación de ninguna cuenta de proveedor. El runtime de StateX lo rechaza de forma segura: exige que `/health` responda `policy: free-only`. No se debe eliminar esa condición ni cambiarla por una mera comprobación de salud.

OmniRoute se instaló de forma aislada para inspección. No se arrancó, no se conectó ningún proveedor y no se hizo ninguna inferencia real.

## Revisión complementaria de proveedores (2026-10-29)

De las opciones solicitadas, **Groq Free es el candidato más comprobable, pero aún no está autorizado para uso real**. La documentación actual de Groq publica niveles Free y Developer, límites por organización, y soporte de tool use para modelos concretos. Por ejemplo, `qwen/qwen3.8-27b` tiene tool use documentado; los límites publicados son orientativos y Groq indica que los exactos dependen de la organización. No puedo afirmar que el proyecto tenga esa cuota o nivel de cuenta.

Qwen presenta dos rutas distintas que no deben confundirse: la documentación de Qwen Code indica que Qwen OAuth gratuito terminó el 15-04-2026; Model Studio estándar es pay-as-you-go por defecto y su cuota gratuita puede pasar a facturación automática salvo que se active su modo de parada al agotar cuota. Cerebras publica un tier de API Free a $0, pero la documentación consultada no permite confirmar que un modelo concreto con tool calling esté disponible en la cuenta local ni fija aquí el límite de cuota de esa cuenta.

Groq también tiene un nivel Developer con facturación por uso, y la documentación legal prevé cargos según el nivel y precios contratados. Así que una key no demuestra por sí misma que la cuenta permanezca en el nivel Free. No usé ni inspeccioné credenciales o consolas de cuenta.

Para la prueba futura, el candidato de protocolo sería `groq/openai/gpt-oss-120b` en la ruta de provider pinning de OmniRoute (modelo upstream exacto `openai/gpt-oss-120b`): figura en el registro Groq del checkout `3.6.1` y Groq documenta tool calling para ese modelo. No está habilitado ni autorizado. Faltan confirmar desde la organización de StateX el tier Free, la cuota actual, la ausencia de cuentas adicionales en OmniRoute y la respuesta de agotamiento sin facturación. La API de Groq también publica este modelo con precio por tokens para el tier Developer, así que conocer el ID no basta. Si no se demuestra la cuenta Free sin cargo al agotar cuota, queda excluido.

OmniRoute contiene fallback global para combos y un emergency fallback hacia NVIDIA para errores de presupuesto. En el camino de chat single-model, ese emergency fallback se omite cuando la solicitud trae tools (como hace Free Agent), pero eso no certifica la cuota/tier de Groq ni impide rotación entre varias credenciales de Groq. Una capa externa tendría que llamar la ruta provider-pinned, impedir combos, comprobar que existe una sola conexión Groq y detectar cambios antes de anunciar `free-only`. La configuración normal de OmniRoute no expone una afirmación comprobable de tier de cuenta; el adaptador no puede inferirla del nombre del modelo o del coste de una respuesta.

La cuota pública no equivale a una cuota restante de la cuenta. Los límites publicados por Groq son de orden de magnitud y pueden cambiar; para planificar el test hacen falta los valores actuales del panel de esa organización. El ciclo Read → aprobación → Write → Read normalmente requiere cuatro inferencias (Read, propuesta de Write, Read de verificación y respuesta final); propondríamos un máximo de **4 peticiones**, 512 tokens de salida por petición y una única ejecución sin reintentos. Ese límite solo se puede preparar como comando después de implementar y validar la capa de compatibilidad.

## Instalación y requisitos

- Licencia declarada: MIT.
- OmniRoute `3.6.1` declara Node `>=18 <24`. El Node global de esta máquina es `v24.22.1`, incompatible. Para inspección se descargó Node `v22.23.3` dentro del directorio temporal aislado.
- Dependencias descargadas con `npm ci --ignore-scripts`. No se ejecutaron hooks de instalación.
- La suite completa de OmniRoute no quedó validada: requiere construir el binding nativo `better-sqlite3`; al omitir scripts, las pruebas que usan SQLite fallan. Además, una prueba intenta abrir un listener local y el sandbox la bloqueó. No se debe interpretar ese intento parcial como una suite verde.
- El puerto predeterminado es `20128`; `API_HOST` permite limitar el API a `127.0.0.1` y `DATA_DIR` permite aislar SQLite/configuración. La configuración de ejemplo incluye secretos de aplicación (`JWT_SECRET`, `API_KEY_SECRET`, `INITIAL_PASSWORD`) y almacenamiento de llamadas. No se creó una instancia ni se tocaron credenciales.

## Modelos “gratuitos” anunciados

El README de OmniRoute anuncia Qoder, Qwen, Kiro/AWS Builder ID, Gemini CLI, NVIDIA NIM, Cerebras, Groq, Pollinations, Cloudflare, Scaleway y otros como rutas gratuitas. Son afirmaciones del README, no una verificación de disponibilidad o derecho de uso de esta cuenta.

| Grupo anunciado | Acceso anunciado | Verificación de coste para esta cuenta |
|---|---|---|
| Qoder, Qwen, Kiro, Gemini CLI | PAT, device code, OAuth/Builder ID o cuota de CLI | No verificada; depende de elegibilidad y cuota de la cuenta |
| NVIDIA, Cerebras, Groq, Cloudflare, Scaleway, LongCat | API key y tier/cuota gratuita del proveedor | No verificada; requiere comprobar cuenta, límite y política de facturación |
| Pollinations/Puter y otras rutas sin clave | Servicio externo sin clave según README | No hay garantía demostrada de disponibilidad, coste, privacidad o continuidad |

Por tanto, la lista configurada de candidatos seguros es **vacía**. No se habilitó ningún proveedor. El nombre o prefijo del modelo no demuestra precio cero. Una cuota gratuita puede agotarse, cambiar o estar asociada a una cuenta con facturación.

OmniRoute ofrece combos y fallback configurables, incluyendo opciones de suscripción, API de pago y modelos baratos. La configuración manual de un combo “free” no es una barrera de seguridad: no impide que cambie el catálogo, la entitlement del proveedor o la semántica de fallback. No se debe usar `auto`, combos ni fallbacks para un objetivo de coste cero sin una allowlist externa y verificable por cuenta/modelo.

## Compatibilidad del protocolo

OmniRoute expone `POST /v1/chat/completions`; su documentación describe `tools`, `tool_choice`, assistant `tool_calls`, mensajes `role: tool` con `tool_call_id`, streaming SSE y `usage` OpenAI cuando el upstream lo proporciona. El runtime StateX ya puede seleccionar la URL con `STATEX_FREE_ROUTER_URL`; no necesita duplicar el runtime ni cambiar permisos.

Pero esto solo acredita compatibilidad de forma, no el contrato de seguridad necesario:

- `/health` de OmniRoute no proporciona la aserción `policy: free-only` que exige StateX.
- El coste puede estar ausente o estimado según proveedor; `usage.cost` no es prueba de que el cargo real haya sido cero.
- `model` puede identificar el modelo seleccionado, pero no certifica tier, precio efectivo o fallback real.
- `finish_reason` y `tool_calls` son normalizados por los traductores, pero el resultado depende de cada proveedor y modelo.
- Hay reportes upstream de problemas en historial OpenAI de tool calls y cache semántica. No se hizo una prueba end-to-end del servidor ni de ningún proveedor; la suite propia de StateX sí valida el ciclo contra mocks.

## Pruebas offline realizadas

`node scripts/test-free-agent.mjs`: **21 comprobaciones superadas, 0 fallidas, 0 solicitudes reales**. Incluye ciclo Read → aprobación → Edit → Read, conservación de IDs y resultados de herramientas, rechazo de respuestas con coste positivo/desconocido, health incompatible, errores 403/429/503, cancelación y ausencia de invocaciones de SDK/CLI.

La suite de OmniRoute se inició con Node 22 y respuestas/configuración locales, pero se interrumpió al comprobar que faltaba el binding nativo SQLite (instalación con scripts desactivados) y el sandbox impidió un listener de una prueba. No se completó ni se declara aprobada.

## Configuración disponible y límite actual

La variable de StateX ya existente es:

```sh
STATEX_FREE_ROUTER_URL=http://127.0.0.1:20128
```

No basta con establecerla: `gatewayHealthy()` rechazará OmniRoute antes de enviar una solicitud porque su health no anuncia `policy: free-only`. Mantener este fail-closed evita que Mia use `auto` o que un fallback de pago quede oculto. No se añadió un bypass ni una integración de proveedor.

## Preparación de la prueba real pendiente

No se ejecutó. Para reconsiderarla primero hace falta:

1. Elegir un único proveedor/modelo cuyo precio cero y cuota gratuita estén confirmados para la cuenta concreta, sin modificar las credenciales existentes.
2. Demostrar con configuración/código que solo ese candidato queda habilitado y que cualquier agotamiento termina en error sin fallback.
3. Proporcionar una aserción local verificable que StateX pueda exigir (proveedor/modelo efectivo y coste cero conocido); respuestas con coste desconocido deben fallar cerradas.
4. Revisar la retención local de logs/cache de OmniRoute y aislar su `DATA_DIR`.
5. Solo después, pedir autorización específica para el ciclo de Mia en workspace temporal: Read → aprobación → Write → Read, límite de una tarea y tokens fijado.

## Uso y rollback

No hay un servicio OmniRoute que arrancar o detener en el estado actual. La instancia instalada para evaluación está aislada en `/private/tmp/statex-omniroute-eval`; el gateway actual de StateX en `127.0.0.1:4141` no se cambió.

Cuando exista aprobación y configuración segura, OmniRoute tendría que ejecutarse con Node 22, `PORT=20128`, `API_HOST=127.0.0.1` y un `DATA_DIR` aislado. Para volver al router actual se elimina únicamente la selección temporal `STATEX_FREE_ROUTER_URL` del proceso de StateX y se conserva su valor predeterminado `http://127.0.0.1:4141`; no se debe detener el gateway existente como parte de ese rollback.
