# StateX HQ — Free Agents Runtime MVP

## Resultado y arquitectura

Se conserva la oficina, los personajes, el chat, Board y los perfiles originales.
`model: free-agent:auto` selecciona un motor propio TypeScript que usa fetch contra
la API OpenAI del gateway local existente. No ejecuta Claude SDK, Claude Code,
Codex CLI, Bash, MCP ni herramientas de red. No se añadieron dependencias.

Recorrido: chat/WebSocket existente → Employee.runFree → runFreeAgent →
GET /health + POST /v1/chat/completions → Gateway seguro → proveedor →
Read/Write/Edit local → aprobación existente del chat → resultado al modelo.

La ejecución gratuita no construye las instrucciones de Claude, lee CLAUDE.md,
carga plugins, ejecuta hooks, ni usa skills/MCP o herramientas de oficina.
Sólo recibe el prompt del perfil, el mensaje del usuario y el historial de esa sesión.
Board puede asignar tareas al mismo Employee, pero el modelo no recibe capacidades
para actualizar Board o coordinar colegas; la gestión sigue siendo manual en este MVP.
Las reuniones pueden hablar con estos empleados; la síntesis automática con Claude
y la escritura automática de memoria de free-agent están deshabilitadas expresamente.

El SDK se carga dinámicamente sólo para los motores anteriores o sus funciones
auxiliares cuando corresponda. La dependencia de desarrollo sigue en package.json
para conservar compatibilidad con upstream; el camino free-agent no la carga.
En las pruebas del servidor completo se prohíben su importación y los subprocesos.

## Arranque local

Con las dependencias existentes:

```sh
npm run build
npm run mvp:free
```

El preparador no arranca servicios ni usa proveedores. Crea una oficina temporal
con Mia, Alex y Sam, todos con free-agent:auto y permissionMode=default; incluye
README.md y TASK.txt. Imprime un comando como:

```sh
STATEX_FREE_ONLY=1 npm start -- --dir '/ruta/temporal/statex-hq-mvp-XXXXXX' --port 4748 --no-open
```

El gateway debe estar disponible en http://127.0.0.1:4141. Para otro puerto local,
añadir STATEX_FREE_ROUTER_URL=http://127.0.0.1:PUERTO al mismo comando.
La URL admite únicamente HTTP en 127.0.0.1 o ::1, sin path, credenciales, query,
redirecciones ni destinos remotos. La oficina se abre en http://127.0.0.1:4748.
Si un puerto está ocupado, elegir otro; no detener servicios existentes.

Las claves permanecen únicamente en el gateway; esta configuración no las pide,
lee ni copia. No se modifican .env ni perfiles existentes. En Settings → Models
aparece StateX Free Agent; en el perfil se selecciona StateX Free Agent (auto).
El modelo efectivo se muestra tras la respuesta y también en la actividad de cada
inferencia. El coste reportado se muestra como $0 o unreported, nunca se inventa.
El ledger cuenta cero bajo la política free-only y los tokens reportados; no implica
que un proveedor haya comunicado explícitamente el coste cuando falta ese campo.

STATEX_FREE_ONLY=1 bloquea los otros motores incluso si un perfil antiguo los
solicita; no ejecuta sus sondeos, login, instalación, sincronización de agentes a
Claude ni catálogo OpenRouter nativo. En modo normal, las integraciones anteriores
siguen disponibles y free-agent es opt-in mediante el panel/configuración.
No activar los motores nativos para una oficina que deba ser exclusivamente gratuita.

Para la prueba, enviar TASK.txt a Mia. Revisar la autorización Edit/Write: muestra
los argumentos exactos del cambio. Aprobar sólo la edición del README temporal.
Mia debe leerlo de nuevo y el archivo debe contener exactamente una línea
StateX HQ Agent Test OK. Alex y Sam usan el mismo runtime, sin otra infraestructura.
No enviar esta tarea a un gateway con proveedores reales sin autorización específica:
la validación realizada fue completamente simulada.

## Política y límites

- Sólo se acepta free-agent:auto. El cliente HTTP envía model=auto, tres herramientas,
  max_tokens=512 y stream=false. No expone parámetros de routing o plugins del cliente.
- Antes de cada solicitud se exige health status=ok y policy=free-only. El componente
  de confianza es el Gateway auditado: comprueba precios reales cero, excluye precios
  desconocidos, impone max_price=0 y desactiva fallbacks internos de OpenRouter.
  Puede hacer fallback únicamente entre candidatos gratuitos verificados. El runtime
  no reintenta ni decide otra ruta, y para ante 402/403/429/5xx o respuestas inválidas.
- El health no es una atestación criptográfica: no conectar otro servicio que sólo
  anuncie free-only sin auditar sus controles. El coste observado después de responder
  tampoco sustituye al bloqueo preventivo del gateway. No se modificó su código.
- Se exige modelo efectivo, usage válido y finalización stop/tool_calls. Se rechazan
  costes distintos de cero o inválidos, respuestas truncadas, IDs duplicados y JSON
  de herramientas malformado antes de ejecutar sus efectos.
- Máximo seis solicitudes de inferencia al gateway, doce herramientas, 512 tokens de
  salida por solicitud y dos minutos por ejecución, incluida la aprobación. No se
  ejecutan herramientas pedidas en la sexta respuesta porque no quedaría continuación.
  El límite de 24.000 tokens se comprueba con usage observado y evita continuar: no
  es una reserva/tokenización previa ni un límite exacto de tokens de entrada.
  Los intentos internos gratuitos del gateway no cuentan como nuevas solicitudes del
  runtime; no hay garantía de cancelar una inferencia upstream ya enviada.
- Historial/prompt limitado a 256 KiB, respuesta HTTP a 512 KiB y archivos UTF-8 a
  64 KiB. Sin imágenes, archivos adjuntos, streams de tokens ni bloques extendidos
  de razonamiento. Campos de mensaje no soportados producen error explícito.

## Archivos y permisos

Read usa file_path relativo; Write usa file_path/content; Edit usa
file_path/old_string/new_string, con una coincidencia exacta y única. Los esquemas
son estrictos, sin propiedades extra. Para sobrescribir hay que haber leído los
bytes actuales en esa ejecución. Toda escritura pide aprobación individual,
independientemente de allowedTools, acceptEdits o bypassPermissions. Plan y reuniones
son de sólo lectura. No hay botón Always allow para estas autorizaciones.

Se comprueban cwd canónico, límites reales, cada componente de ruta, symlinks,
archivos especiales, tamaño, UTF-8 y hardlinks. Se excluyen rutas como .env,
.git, .claude, .pixel-office, .ssh, .aws, .codex, secrets y credentials. No se crean
directorios automáticamente. Tras aprobar se revalidan ruta y contenido. El commit
síncrono usa archivo temporal exclusivo y rename, sin seguir un symlink final.
Los archivos escritos quedan con modo 0600. Cancelar retira la aprobación y aborta
el HTTP local; no ejecuta escrituras pendientes.

Esto NO es un sandbox de sistema operativo. No ofrece aislamiento frente a un
proceso hostil externo que renombre directorios concurrentemente bajo el mismo UID
entre syscalls; para ese entorno se necesita aislamiento OS/UID. No se presenta
como un servicio multiusuario con workspaces no confiables.

Se reutiliza Store: sesiones con prefijo free-agent: y metadata aditiva
freeAgentHistory, máximo veinte sesiones por empleado. No hay migración. Se guarda
el usuario y cada ronda completa, incluyendo tool_call_id/resultados; reset/cambio
de motor cambia la identidad de sesión. Una cancelación/error no deshace escrituras
ya aprobadas; una ronda incompleta no se reproduce automáticamente. Los historiales
contienen texto de archivos leídos: tratar el dataDir como datos privados, usar un
workspace limitado y permisos de directorio/umask adecuados.

## Hetzner

El mismo proceso Node y gateway Python pueden ejecutarse en Linux con usuario sin
privilegios, workspace dedicado, umask 077, datos persistentes y ambos servicios
escuchando en loopback. Para acceso personal usar túnel SSH. No exponer la oficina
sin autenticación adicional: la aplicación original confía en quien puede llegar
a su puerto. No hay configuración de despliegue, apertura de puertos ni contenedores
nuevos en esta entrega. No se ha desplegado o validado en una máquina Hetzner real.

## Validación offline

Resultado final: npm test correcto (diez grupos), veinte pruebas del runtime
correctas, cero fallos; npm run typecheck y git diff --check correctos. La prueba
visual --free pasó quince comprobaciones sin excepciones JavaScript.

npm test conserva los grupos heredados y añade scripts/test-free-agent.mjs.
Esta prueba intercepta fetch, utiliza temporales y bloquea la carga del SDK. La
fixture Python ejecuta el Gateway/FastAPI reales con httpx.MockTransport, devuelve
un catálogo con un modelo de pago engañosamente terminado en :free, otro con precio
incompleto y uno realmente gratuito. Bloquea socket.connect/connect_ex; no lee keys.

El caso Mia ejecuta cuatro inferencias simuladas: Read → Edit → Read → respuesta.
Comprueba el README antes y después de autorizar, tool IDs/resultados, modelo efectivo,
120 tokens de entrada y 40 de salida simulados, coste reportado 0 y ausencia de keys.
Otro caso arranca el servidor de producción en una oficina temporal, bloquea todos
sus subprocesos y usa WebSocket real: Mia aprueba el cambio; Alex y Sam recorren el
mismo runtime y deniegan su modificación. Comprueba la persistencia de la sesión.

También se cubren traversals, paths absolutos, symlinks/hardlinks, cambios durante la
aprobación, archivos binarios/grandes/especiales, argumentos inválidos, denegación,
Read-before-write, plan, límites de solicitudes/historial/tokens, Stop mientras se
espera aprobación, HTTP cancelado, errores 402/403/429/5xx y coste inválido/no reportado.
El coste real y la calidad de un modelo remoto no se han verificado en esta entrega.

Prueba visual gratuita: node scripts/test-statex-ui.mjs --free. Usa Chrome y API/WS
simulados, verifica Settings/modelo, autorización nativa sin Always allow y cambio
al modelo efectivo, además de Board/Meeting/Hire/chat/perfil y móvil/tablet.
Los tests de loopback requieren permiso fuera del sandbox del entorno de Codex.

## Cambios

Nuevos módulos src/server/free-agent.ts y free-agent-tools.ts; integración pequeña
en employee.ts/providers.ts/index.ts. Carga diferida del SDK en office-tools.ts,
runs.ts y meeting.ts, con bloqueo de funciones auxiliares en modo gratuito.
Settings y traducciones añaden el proveedor. El preparador existente gana --free
y package.json añade mvp:free y la prueba. Fixtures offline y test de UI ampliado.
No se eliminan proveedores, código, tests o dependencias existentes.

## OmniRoute

Se revisó https://github.com/ChrisCompton/omniroute como candidato futuro a sustituir
el gateway. Su documentación ofrece API OpenAI, combos gratuitos y fallback, pero
su alcance incluye rutas de pago y no se ha verificado una política fail-closed
idéntica a la actual. No se instaló ni integró. La sustitución requiere auditar
precios/fallbacks y el contrato health/free-only; no basta cambiar la URL.
