# StateX HQ — Coordinación multiagente MVP

## Arquitectura

La coordinación reutiliza el Board persistente (`board.json`), `Employee.startTask()` y el Free Agent Runtime existente. No crea procesos, frameworks ni proveedores nuevos. En esta primera iteración sólo Alex (`alex`, rol Personal Assistant) puede crear una delegación, y sólo puede asignarla a Mia (`mia`) cuando ambos usan `free-agent:auto` y `taskSessions` está activo.

Alex dispone de `delegate_task`, `get_task_status` y `complete_task`. Mia recibe `submit_task_result` únicamente dentro de su sesión de una tarea delegada. Read, Write y Edit siguen pasando por `WorkspaceTools` y la aprobación actual; Bash y las herramientas genéricas del Board no se exponen al runtime gratuito.

El Board guarda objetivo, criterios, estado de coordinación, historial, resultado estructurado y presupuesto. Los estados de coordinación son `pending`, `assigned`, `running`, `review`, `completed`, `failed`, `blocked` y `cancelled`; los estados visuales originales del Board siguen siendo compatibles. La oficina muestra una etiqueta de estado y conserva el resumen en la nota de tarea.

## Verificación y límites

- Mia debe leer cada archivo que entrega después de la última modificación. `submit_task_result` rechaza rutas fuera del workspace, enlaces simbólicos o archivos no leídos.
- Alex debe leer los archivos entregados durante la misma ejecución en la que llama a `complete_task`. El servidor vuelve a comprobar que las lecturas corresponden al contenido actual.
- Sólo entonces la tarea pasa a `completed`/`done`. Un error del worker queda bloqueado; finalizar sin resultado estructurado queda `failed` y bloqueado.
- Una tarea delegada activa no se duplica. En esta fase existe como máximo una delegación activa Alex → Mia. Alex no puede delegar a Alex ni Mia puede crear subdelegaciones.
- Si Mia entrega algo que no cumple los criterios, Alex puede solicitar una sola corrección sobre el mismo ID de tarea mediante `delegate_task`; no se crea una subtarea. El presupuesto original continúa compartido y limita también esa corrección.
- El presupuesto de inferencias, tokens y herramientas se comparte entre Alex y Mia. `STATEX_FREE_COORD_MAX_REQUESTS` permite 7–12 inferencias y usa 10 por defecto. Se conserva el límite global existente de 24.000 tokens y 12 llamadas a herramientas por tarea. Los límites normales de salida por inferencia también siguen vigentes.
- Tras reiniciar, tareas delegadas aún abiertas quedan bloqueadas para revisión manual. Nunca se reejecutan escrituras automáticamente. El botón de inicio no permite reanudar estados terminales.
- Cancelar una tarea detiene primero a Mia, quita la tarea de su cola y persiste `cancelled`.

## Arranque y prueba offline

```sh
npm run dev:free
npm test
npm run typecheck
```

La prueba `scripts/test-multi-agent.mjs` ejecuta el runtime real con respuestas locales simuladas y comprueba:

1. Alex crea una tarea real del Board para Mia.
2. Mia lee el workspace, solicita aprobación para escribir, crea `statex-test.md`, lo lee y envía un resultado estructurado.
3. Alex recibe el resultado, consulta el estado, vuelve a leer el archivo y completa la tarea.

El test bloquea cualquier URL fuera de loopback y no consume cuota de Groq ni OpenRouter.

## Primera prueba real controlada (no ejecutada)

Con `npm run dev:free`, comprueba primero que el gateway local informa `free-only`, que el proveedor elegido dispone de una atestación gratuita vigente y que Alex y Mia aparecen con `free-agent:auto`. Usa una oficina y workspace aislados, con permiso de escritura en modo `default` y Bash no disponible. En el chat de Alex pide crear `statex-test.md` con una frase única, delegando el trabajo a Mia y solicitando revisión. Autoriza sólo esa escritura en el diálogo de permisos; luego confirma en el Board los estados `assigned → running → review → completed`, la nota de resultado y el archivo verificado. Detén la oficina con `npm run stop:free`.

No se ejecutó ninguna solicitud a proveedores reales como parte de esta implementación.
