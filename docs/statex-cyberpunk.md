# StateX HQ — Oficina cyberpunk

Actualización visual sobre el MVP, sin cambios en src/server, proveedores, agentes,
permisos, credenciales ni persistencia. Se conserva el trabajo experimental previo.
No se añadieron dependencias ni se modificó ../agent-lab; sólo se leyó como referencia.

## Apariencia

El tema predeterminado existente usa ahora paredes grafito/azul petróleo, suelo de
paneles con juntas pixeladas, segmentos turquesa y violeta y una iluminación estática
sutil en los bordes. Las ventanas muestran una ciudad nocturna decorativa. Los
escritorios tienen superficies metálicas, cantos turquesa y patas con acentos violeta.
Las pantallas conservan su representación original del estado/herramientas del agente,
con colores nuevos para el estado de reposo. Las miniaturas usan el mismo acabado.
Los nombres de las salas tienen contraste claro desde la primera carga.

La ficha de agente es la cabecera del chat existente: retrato pixel-art, nombre, rol,
modelo y estado suministrados por el estado actual de la aplicación. Conserva los
botones de perfil, detener, reiniciar, cerrar y curar cuando corresponde. No añade
contadores, actividad, uptime, commits ni otra información del prototipo que no
exista en Pixel Office. Los dibujos y cuadros del escenario son decoración, no
telemetría. Las capturas de prueba usan datos explícitamente simulados.

La tarjeta se adapta al ancho del chat y sitúa las acciones debajo de la identidad.
Se verificaron escritorio 1440×960, móvil 390×844 y tablet 820×1180. Se mantienen los
personajes, sus animaciones, mobiliario, rutas y controles de edición existentes.
Los otros seis temas conservan sus acabados. No se migran oficinas: para ver el
nuevo escenario, seleccionar el tema predeterminado en la configuración de la oficina.

No hay nuevos timers, bucles, filtros de imagen, blur de fondo o partículas.
Los acentos de iluminación son rectángulos y superficies estáticas dibujados en el
canvas actual. Se mantiene el soporte existente de movimiento reducido. No se ha
realizado un benchmark de FPS ni una prueba en dispositivos físicos.

## Archivos de esta actualización

- web/office.js: suelo, paredes/ventanas, escritorios, miniaturas y contraste inicial.
- web/index.html: una clase en la cabecera existente para identificar la ficha.
- web/style.css: superficies, acentos y ficha adaptable; contraste de salas oscuras.
- scripts/test-statex-ui.mjs: ampliación de la prueba de interfaz offline del MVP.
- docs/statex-cyberpunk.md: alcance y resultados.

## Validación

- npm test: nueve grupos correctos, incluidos los tests existentes y la configuración
  de Mia. No se eliminaron tests ni se regeneraron fixtures para aceptar resultados.
- npm run typecheck: correcto.
- node scripts/test-layout.mjs tras el ajuste de contraste: equivalencia de geometría
  y mobiliario en siete temas, validación, 3453 ediciones válidas, 1185 inválidas
  rechazadas y 531 cambios con personajes en distintos estados; correcto.
- npm run test:ui: 13 comprobaciones correctas; cero excepciones JavaScript. Incluye
  oficina/canvas, ficha con los campos suministrados, envío de chat a transporte
  simulado, apertura de Board en modo manual, selección/cancelación de Meeting,
  Settings/OpenRouter, móvil/tablet sin overflow, controles móviles dentro de la
  pantalla, movimiento reducido, perfil y Hire.
- git diff --check: correcto.

Las pruebas visuales usan Chrome con perfil temporal, API/WebSocket local simulado
y peticiones externas de página bloqueadas. No importan el servidor de producción
ni ejecutan agentes. No prueban inferencias reales, edición de archivos por agentes
ni reuniones con modelos. No se arrancaron o reiniciaron servicios existentes.
Las verificaciones que necesitan escuchar en loopback se ejecutaron con permiso
porque el sandbox inicialmente devolvió EPERM.

El test imprime rutas temporales de cinco capturas: office.png, agent-card.png,
settings.png, mobile-agent.png y tablet.png. Se pueden regenerar con npm run test:ui.
No se hicieron commits, push ni despliegues.
