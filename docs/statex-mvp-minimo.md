# StateX HQ — MVP con las integraciones existentes

## Decisión

Congelar el desarrollo de free-model-router y del adaptador Anthropic. Conservar
su código, tests, harness y resultados como experimento, sin incorporarlos al
arranque ni a las dependencias de Pixel Office. No se han eliminado ni movido.

Camino principal: **Mia → integración OpenRouter existente → Messages API de
OpenRouter**. Mantener Claude y Codex como alternativas seleccionables manualmente.
No añadir un ejecutor, adaptador, framework o sistema de orquestación.

## Lo que ya existe y permite el MVP

`src/server/providers.ts` ya ofrece OpenRouter, modelos personalizados prefijados
con `openrouter:` y su catálogo. `openrouterEnv()` fija la URL oficial
https://openrouter.ai/api, usa la clave OpenRouter propia del servidor y asigna
el modelo elegido a todas las categorías del SDK, incluidos subagentes.
`src/server/employee.ts` reutiliza query(), herramientas, MCP de oficina, sesiones,
streaming y permisos. La API de OpenRouter recibe /api/v1/messages directamente.

No hay que cambiar ANTHROPIC_BASE_URL a mano ni modificar employee.ts/providers.ts.
La integración nativa sigue utilizando Claude Agent SDK: elimina nuestro
traductor, pero no elimina las particularidades del SDK o de cada modelo.

La documentación oficial respalda esa conexión, pero sólo garantiza Claude Code
con el proveedor Anthropic de primera parte. Por tanto, gratuito + tool calling
no acredita por sí solo compatibilidad completa con el agente:
[Claude Code/OpenRouter](https://openrouter.ai/docs/guides/coding-agents/claude-code-integration).

## 1. Configurar Mia mediante la UI, sin cambiar credenciales

1. En Settings → Models, usar OpenRouter con la credencial que ya tenga disponible
   Pixel Office. El servidor utiliza su OPENROUTER_API_KEY o su secrets.json;
   **no lee automáticamente la .env de free-model-router**. No copiar, imprimir,
   guardar otra clave ni ejecutar logout para esta propuesta. Si la credencial no
   está disponible en Pixel Office, dejar la prueba pendiente.
2. Añadir un único ID gratuito fijo, sin prefijo de Pixel Office, a Extra model ids.
   Candidato inicial: `cohere/north-mini-code:free`; su página pública muestra
   entrada/salida gratis y soporte de herramientas. Es un **candidato para validar**,
   no un modelo ya certificado con el endpoint nativo. El intento anterior usó
   nuestro adaptador y no resuelve esa comprobación:
   [modelo oficial](https://openrouter.ai/cohere/north-mini-code:free).
3. Seleccionar ese modelo en el perfil de Mia. Su ID interno será
   `openrouter:cohere/north-mini-code:free`. Conservar sus otros campos.
4. Elegir un directorio temporal como cwd, permisos default y chat manual. No usar
   bypassPermissions, ciclos autónomos, delegación o tareas periódicas para esta
   primera validación. No autoaprobar Write/Edit/Bash mediante allowedTools.

No se encontró un perfil activo de Mia dentro del repositorio: sólo el ejemplo
Software Developer de locales/en.json. No se inspeccionó ni modificó la oficina
privada global para adivinar su ubicación. La configuración anterior es una receta,
no un cambio ya aplicado a un empleado en ejecución.

## 2. Primera tarea nativa, tras autorización nueva

La autorización de la prueba experimental anterior ya está consumida. No se han
hecho nuevas inferencias, llamadas de autenticación ni consultas API de catálogo.
Sólo se consultó código local y documentación/páginas públicas sin credenciales.
Tampoco se arrancó la oficina: sus probes pueden hacer consultas autenticadas y,
en ciertos estados de Codex, una inferencia de salud.

Preparar un directorio temporal independiente con README.md de contenido conocido.
En el chat de Mia, solicitar:

> Trabaja sólo en README.md de este workspace. Léelo, añade una sola línea
> «StateX HQ Agent Test OK», léelo de nuevo y confirma el resultado. No uses Bash,
> no delegues ni consultes otros proyectos. Pide aprobación cuando corresponda.

Usar las herramientas nativas, sin MCP especial para el experimento. El recorrido
Read → Edit → Read → confirmación puede necesitar cuatro respuestas; no heredar
el presupuesto artificial de tres de la prueba anterior ni crear otra capa para
hacerlo encajar. Acordar antes de ejecutar el presupuesto y el permiso de consumo.
Los límites estrictos por solicitud del harness experimental no existen como
controles equivalentes en esta ruta nativa; no se prometen sin verificarlos.

Criterios de aceptación: archivo realmente cambiado una sola vez, contenido exacto
tras relectura, herramientas/resultados visibles en el chat, finalización correcta,
modelo y coste contrastados con la actividad de OpenRouter. Detener ante errores,
cuota agotada o comportamiento incompatible; no cambiar automáticamente a pago.
Un cwd temporal separa el trabajo, pero **no es por sí solo un sandbox OS**.

La UI no es prueba suficiente de gratuidad: su catálogo se cachea una hora y
`Number(precio) || 0` muestra cero también para ciertos valores desconocidos.
Antes de la prueba autorizada, verificar precios originales de entrada y salida,
otras dimensiones aplicables y soporte de tools. La ruta nativa no impone los
max_price ni la validación fail-closed del gateway experimental. No se debe vender
este MVP como una garantía técnica de coste cero equivalente a ese gateway.

## 3. Oficina visual StateX HQ

Después de que Mia complete la tarea:

- Usar el nombre de oficina StateX HQ y las opciones existentes de tema/avatar.
- Para título de pestaña y marca del encabezado, cambiar únicamente ui.title y
  ui.brand en el locale utilizado (hoy se incluyen en y tr). Si se usan ambos,
  mantener esos dos valores en ambos. Lo consumen web/app.js, employee.js e index.html.
- Conservar los créditos/licencia y la estructura de Pixel Office. Logo o colores
  adicionales sólo si hacen falta, como cambios pequeños en los assets actuales.

No se necesita otra web, framework, build separado o catálogo propio de componentes.
Estos cambios visuales son propuestos; no se han aplicado en esta revisión.

## 4. Automático y fallback gratuito, sin convertirlo en requisito de arranque

OpenRouter ofrece ya `openrouter/free`: selecciona modelos gratuitos según las
capacidades necesarias, incluidas herramientas. El servicio hace fallback entre
modelos gratuitos; añadir modelos de pago a una lista de fallbacks sí puede facturar.
[Free Models Router](https://openrouter.ai/docs/guides/routing/routers/free-router),
[limitaciones y fallbacks](https://github.com/OpenRouterTeam/docs/blob/main/cookbook/get-started/free-models-router-playground.mdx).

Tras validar un modelo fijo, se puede evaluar desde la misma UI, sin código:
slug `openrouter/free`, ID interno `openrouter:openrouter/free`. Aún falta comprobar
el ciclo de herramientas por Messages con ese router y con el SDK instalado.
La selección variable dificulta aislar errores; no usarla en la primera prueba.
Esta opción nativa es una alternativa de mínimo mantenimiento, no una afirmación
de que ya se haya integrado free-model-router local.

**Reutilización directa del gateway local: no hay una conexión nativa configurable
por empleado en el estado actual.** OpenRouter tiene URL hardcodeada, sondea /v1/key
y consume su catálogo. El experimento no ofrece ese contrato de proveedor completo.
Sí tiene /v1/messages, pero sólo soporta un subconjunto probado con un perfil SDK
acotado; no es sustituto transparente de las opciones actuales de Employee.
Forzar la ruta Claude con variables globales afectaría también a otros empleados,
autenticación y cómputo de costes. No se propone ese atajo.

Por tanto, el objetivo de selección/fallback mediante free-model-router se
conserva como experimento aplazado. No se elimina su código ni sus tests y no
se sigue desarrollando ahora. No es dependencia para abrir StateX HQ o trabajar
con Mia. Tampoco se añade fallback automático a Claude/Codex: pueden tener coste
y su elección debe ser explícita.

## Mantenimiento y alcance de esta entrega

MVP operativo buscado: un servidor Pixel Office, una oficina, Mia con OpenRouter
nativo, un modelo gratuito comprobado, chat/tareas existentes, Claude y Codex
opcionales. Primer hito: una tarea nativa verificada. Segundo: marca visual.
Tercero, opcional: evaluar openrouter/free sin cambios de motor.

Usar configuraciones y perfiles existentes para datos del usuario; mantener un
diff de marca pequeño y separado. Conservar el nombre/estructura del paquete
original y sus dependencias. Revisar actualizaciones upstream antes de aplicarlas,
sin autoactualizar ni modificar el runtime para sostener el experimento.

Esta entrega modifica sólo documentación. No aplica configuraciones vivas, no
modifica credenciales, no llama a modelos, no arranca/reinicia servicios y no hace
commits, push o despliegues. La compatibilidad gratuita nativa sigue pendiente de
la primera prueba autorizada, no se da por demostrada por las pruebas del adaptador.
