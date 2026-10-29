# StateX HQ Free Agents: desarrollo local

El lanzador coordina la oficina Free Agent y el Free Router local sin consultar
modelos durante el arranque.

## Arrancar

Desde la raíz del repositorio:

```sh
npm run dev:free
```

La oficina queda en `http://127.0.0.1:4748` y el gateway en
`http://127.0.0.1:4141`. El lanzador comprueba la identidad de los servicios
activos y reutiliza los que ya son StateX Free. Para el router verifica `/health`
(`policy: free-only`, proveedor OpenRouter y Groq excluido) y contrasta el PID
que escucha el puerto, su directorio de trabajo, el ejecutable real, los
argumentos Uvicorn, bind y puerto. En macOS valida también el binario
`Python.app` que Homebrew usa como ejecutable real del intérprete asociado al
symlink `free-model-router/.venv/bin/python`. Esto cubre el `exec` de `run.sh`,
que reemplaza el shell y hace que `ps` muestre el binario Python absoluto, no la
ruta del script. En macOS/Linux usa `lsof` y `ps` para esa inspección. Un proceso ajeno,
una política distinta o una identidad que no pueda leerse provoca un error; el
lanzador nunca lo mata.

Si la identidad no se puede verificar, el error indica el motivo y deja el
servicio activo. Para un gateway arrancado desde una terminal, vuelve a esa
terminal y usa `Ctrl+C`. Si ya no está disponible, inspecciona antes el PID:

```sh
lsof -nP -iTCP:4141 -sTCP:LISTEN
ps -p <PID> -o pid=,lstart=,command=
lsof -a -p <PID> -d cwd -Fn
lsof -a -p <PID> -d txt -Fn
```

Comprueba que comando y directorio correspondan a `free-model-router`; deténlo
desde su terminal o gestor de servicios propietario. `npm run stop:free` solo
detiene PIDs lanzados y verificados por el propio lanzador.

La oficina persistente e independiente del proyecto queda en
`.statex-free-dev/office`. Allí se inicializan una sola vez las configuraciones
de Alex, Mia y Sam. Los archivos existentes no se sobrescriben. La carpeta está
ignorada por Git.

El arranque comprueba que no haya tareas o auto-refresh que Pixel Office pudiera
reanudar automáticamente. Si hay trabajo pendiente, detiene el arranque antes
de iniciar servicios. El router carga sus claves desde su configuración
existente; el proceso de la oficina recibe un entorno reducido sin credenciales
de proveedores.

El comando permanece en primer plano cuando controla servicios. `Ctrl+C` o
`SIGTERM` detienen sólo procesos lanzados por el coordinador. Si el router ya
estaba activo antes del arranque, se deja encendido.

## Detener

Desde otra terminal:

```sh
npm run stop:free
```

La parada valida PID, hora de inicio y huella del comando antes de señalizar un
proceso. Un PID reutilizado o un servicio iniciado manualmente no se detiene.

## Tests offline

```sh
node scripts/test-statex-free-launcher.mjs
npm test
npm run typecheck
```

Las pruebas del lanzador usan servicios y procesos simulados; no llaman a
OpenRouter ni Groq.
