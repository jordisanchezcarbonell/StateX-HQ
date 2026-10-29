# StateX HQ — MVP preparado

Oficina pixel-art de Pixel Office con marca StateX HQ, controles oscuros y acento
cian, favicon propio y el motor original. La ruta es Mia → OpenRouter nativo;
free-model-router y el adaptador experimental no se usan ni se han eliminado.

## Arrancar

Con las dependencias existentes:

```sh
npm run build
npm run mvp:prepare
```

El segundo comando **no arranca servidores ni consulta proveedores**. Genera una
oficina nueva en el directorio temporal del sistema y muestra JSON con workspace,
perfil de Mia y el comando exacto de arranque. Copiar ese comando, por ejemplo:

```sh
npm start -- --dir '/ruta/temporal/statex-hq-mvp-XXXXXX' --port 4748 --no-open
```

Abrir http://127.0.0.1:4748. Si el puerto está ocupado, elegir otro con --port;
no detener ningún servicio existente. Para abrir la oficina habitual con la marca
nueva, se mantiene `npm start`, pero no prepara automáticamente a Mia ni cambia
el workspace de empleados existentes.

El servidor real puede consultar el estado de proveedores al arrancar. Esta
entrega no lo ha arrancado contra cuentas reales. La comprobación visual usó
exclusivamente datos simulados. No enviar tareas reales hasta disponer de la
autorización específica para OpenRouter.

## Qué queda preparado

Dentro del temporal:

- .pixel-office/config.json: oficina StateX HQ, localhost, datos locales al temporal,
  modelo OpenRouter añadido al selector, sin sincronizar agentes a otros proyectos.
- .pixel-office/employees/mia/agent.md: Mia, Software Developer,
  model=openrouter:cohere/north-mini-code:free, permissionMode=default y prompt
  limitado al README de prueba. No contiene secretos ni herramientas preaprobadas.
- .claude/settings.json: reglas nativas que deniegan Bash, WebFetch, WebSearch y
  Agent. El ejecutor existente carga settings de proyecto; no se añadió un motor
  de permisos o wrapper. Edit/Write siguen requiriendo aprobación cuando proceda.
- README.md: fixture inicial conocido. TASK.txt: tarea preparada para pegar en chat.

La carpeta de datos, memoria y plugins de la copia de Mia también queda bajo el
temporal. El cwd separado y las reglas de permisos **no equivalen a un sandbox OS**
que impida por sí solo toda lectura exterior. No se anuncia ese aislamiento fuerte.
El temporal puede desaparecer cuando el sistema lo limpie; repetir mvp:prepare
crea otro distinto sin sobrescribir la oficina anterior.

## Clave y modelo de Mia

No se ha leído, copiado, mostrado ni modificado ninguna credencial.
La nueva oficina no hereda secrets.json de la oficina actual ni lee la .env del
router. Para conectarse necesita OPENROUTER_API_KEY ya disponible en el entorno
del proceso del servidor. El script de preparación no la solicita ni la configura.

Si la clave sólo está guardada en la oficina actual, conservarla allí: usar esa
oficina, Settings → Models → OpenRouter y el perfil actual de Mia. Elegir como
working directory el workspace temporal preparado, con sus reglas .claude.
No copiar secrets.json entre oficinas. Esta entrega no modifica la configuración
privada global ni sustituye el perfil de una Mia existente.

En Settings → Models → OpenRouter:

1. Confirmar que la conexión ya está disponible, sin guardar una clave nueva.
2. En Extra model ids, usar `cohere/north-mini-code:free` (sin prefijo openrouter:).
3. En el perfil de Mia, seleccionar ese modelo y permisos Default; cambiar el cwd
   sólo si se usa una oficina existente. No activar auto-refresh ni delegación.

Se añadió una ayuda junto al campo de modelos. El ID es un candidato del plan,
**no una certificación de compatibilidad actual**. Antes de una inferencia real
verificar precio original de entrada/salida y soporte de tools. La ruta nativa
no aplica el guard free-only del experimento. La disponibilidad/capacidad puede
cambiar y el precio mostrado en la UI no basta para garantizar gratuidad.

## Prueba pequeña, pendiente de autorización

Abrir el chat de Mia en modo manual y pegar TASK.txt:

> Read README.md, add exactly one line "StateX HQ Agent Test OK", read it again
> and confirm the result. Only modify README.md. Do not use Bash or delegate.
> Ask before edits when necessary.

Usa Read y Edit/Write nativos, sin la herramienta MCP especial del experimento.
Aprobar únicamente la edición del README temporal cuando se solicite. Revisar el
archivo en disco: debe conservar el texto inicial y contener la línea exactamente
una vez. Comprobar la relectura en la actividad del chat y el consumo/modelo en
OpenRouter. No activar fallback a modelos de pago ni declarar éxito sólo por la
respuesta textual del agente. La prueba no tiene el límite artificial de tres
inferencias del experimento anterior; su presupuesto requiere autorización nueva.

No se ejecutó esta tarea real en la entrega. La prueba anterior contra el gateway
experimental no demuestra que este recorrido nativo funcione con el candidato.

## Validación realizada

- `npm test`: build y nueve grupos de tests correctos. Incluye los tests existentes
  de retry, archive, digest, progress, layout, market, integrations y skills.
- Nuevo test-statex-mvp: carga el perfil generado mediante los loaders reales de
  configuración/agentes, comprueba cwd/modelo/permisos, regla deny de Bash y que no
  se creen archivos de credenciales.
- `npm run typecheck`: correcto.
- `npm run test:ui`: siete comprobaciones correctas en Chrome headless: marca y
  roster, canvas pixel-art, chat de Mia, Settings/OpenRouter, móvil sin overflow,
  perfil con modelo/permisos seleccionados y pantalla de contratación. Cero
  excepciones JavaScript; servidor API/WebSocket simulado, cero llamadas a modelos.
  El test bloquea las peticiones externas de página y usa un perfil Chrome temporal.
  Requiere Chrome instalado (CHROME_BIN opcional), sin descargar dependencias.
  Genera capturas en un directorio temporal que muestra al terminar.

Los tests de integración/UI necesitan permisos para escuchar en loopback; el
sandbox de Codex los bloqueó inicialmente con EPERM. Al ejecutarlos con permiso
del entorno pasaron. No se reinició el servidor de oficina existente.

## Archivos del MVP y mantenimiento

- locales/en.json y tr.json: título/marca StateX HQ y ayuda del modelo gratuito.
- web/index.html, employee.html e hire.html: branding de fallback, favicon y label.
- web/style.css: variables de color y pocos estilos de controles; canvas/escena,
  temas, mobiliario y animaciones originales permanecen intactos.
- web/settings.js: ayuda de selección; no cambia modelos/precios/credenciales.
- web/statex.svg: favicon vectorial pequeño.
- scripts/prepare-statex-mvp.mjs, test-statex-mvp.mjs y test-statex-ui.mjs.
- package.json: mvp:prepare, test:ui y test de configuración añadido a npm test.

No se modificaron src/server, engine de empleados, estructura persistente original,
dependencias, LICENSE ni créditos. No se añadieron frameworks o adaptadores. El
diff de producto se concentra en marca/estilos; el resto son preparación y tests.
No se hicieron commits, push o despliegues. No se eliminaron tests anteriores.
