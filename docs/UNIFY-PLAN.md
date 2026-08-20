# Stage It Live — unification plan (WIP)

Bring Dave's "Stage It Live" (`/Users/domoconnell/Development/Projects/stage-it-live`)
functionality + connections into THIS app, unified under our UI. Rename the whole
project to **Stage It Live**. No functionality of Dave's may be lost.

## Target end-state (top-level "apps")
- **Home** — new default landing app (opens here).
- **Surfaces** — surface designer + `/surface?s=<id>` viewer (Dave's dashboards/widgets).
- **ATEM Controller** — ours (unchanged).
- **ProPresenter Timers** — ours (Timer Designer; absorbs Acceptance, which leaves the top level).
- **Wireless Mics** — ours (Sennheiser; already built).
- One app per Dave connection: **Smaart, QLab, REAPER, HyperDeck, Companion, DiGiCo, ProdCom, UniFi, Computer, Connection check, Weather** (+ Demo).
- Cross-app: **Mics** may unify Sennheiser + mic live/standby/off cues (TBD after inventory).
- **Global Settings/Connections** — connector instances + Companion custom variables, app-wide.

## Foundation decision (recommended)
Host = OUR stack (Node ESM server + Next static export → public/, rsync to Pi, no DB build on box).
Port Dave's connector *protocol logic* + the widget/surface system INTO ours. Add a lightweight
persistence + connector-instance layer (Dave uses SQLite+auth+events; we likely keep single-user,
file/SQLite-lite persistence — confirm scope of auth/events with user).

---
## Confirmed: Dave's Surfaces (dashboard/widget) architecture — to re-implement
(from deep-dive of apps/web)

- Stack: Vite+React+react-router+react-query+zustand+zod+Tailwind v4, **react-grid-layout** grid.
  Ours is Next static export — we re-implement the same *contracts* in our Next/Tailwind UI.
- Dashboard = "Profile": `{ id, owner, name, isShared, isDefault, layout }`.
  `layout = { widgets: WidgetPlacement[], layouts: {lg,md,sm: LayoutItem[]}, hideTitles, autoArrange }`.
  One shared `widgets[]` (identity+settings) + 3 per-breakpoint geometry arrays keyed by item `i`.
  Breakpoints lg(1200/12col) md(768/8) sm(0/4), rowHeight 40.
- WidgetPlacement: `{ i, widgetType, instanceId|null, title|null, config, scale(0.6–1.8), titleHidden }`.
- **WidgetDef contract** (registry): `{ type, label, description, component, configSchema(zod),
  defaultSize{w,h,minW,minH}, topics(instanceId,config)→string[], supportedTypeIds?, 
  supportsProblemsOnly?, seedConfig?(streams) }`. registerWidget/getWidget/listWidgets/widgetsForType.
- WidgetProps: `{ config, instanceId, title, health?, problemsOnly?, density:'full'|'compact' }`.
- Settings UI auto-derived from configSchema via a SchemaForm (no hand-written forms), with dynamic
  choices (stream/field/mic pickers) from live data + connector StreamDecls.
- WidgetShell: error boundary, connection/staleness badges (subscribes $status + primary topic),
  density (ResizeObserver), content zoom (scale), drag handle = header only.
- Realtime: one WS `/ws`, ref-counted topic subs; topics `mi:<instanceId>:<streamId>`, `sys:<name>`,
  `usr:<userId>:<channel>`; client store dedupes by seq, tracks staleness from rateClass/poll interval.
  Server msgs: hello/snap/data/ack/pong/bye. Client: sub/unsub/cmd/ping.
- Viewer: Dave uses `/d/:profileId` + Focus mode (fullscreen, hides chrome); no separate kiosk URL.
  **We want** an explicit `/surface?s=<id>` public viewer (new surface area — build it).
- Builtin widgets → connector: clock/running-order/status-board/problems-board/event-log (platform),
  weather(weather), comms-transcript & comms-callouts(prodcom), mic-cue(platform+sennheiser),
  connection(netcheck), system(sysmon), rf-rack(sennheiser), network-health(unifi),
  console-messages(digico), level-meter(smaart/demo), spl(smaart), state(hyperdeck/reaper/qlab/demo),
  timers(propresenter), variables(companion).

## Pending (awaiting agents)
- Server connector framework + instance/config/persistence model + realtime server.
- Full connector-by-connector functionality inventory (no loss).
- Shared contracts (StreamDecl/FieldDecl/TypeCatalogue), OSC `/sil` + Companion `sil_` scheme,
  micCues/comms/alerts/modes/notify/history subsystems, design principles.

---
## Confirmed: Dave's server architecture (from deep-dive of apps/server)
- **Connector framework (declarative, no inheritance):** `ConnectorModule = { meta, create(), createSimulator(), simulatedConfig(), discoverConfigOptions? }`.
  `Connector = { start(ctx), stop(), exec?(cmd,input) }`. `ctx` injects publish/recordHistory/setStatus/fail/timers/config/simulate/instanceId.
  `meta = { typeId, displayName, configSchema(zod→also admin form), streams[StreamDecl], commands[CommandDecl], conditions[ConditionDecl], capabilities:{control}, tier, unproven?, vendorNotes? }`.
  StreamDecl `{ id, label, rateClass, history?, metricFields?, fields[FieldDecl] }` — field ORDER is load-bearing (first number = headline, widgets bind first field).
- **Registry** static (MODULES array of all 14). **Supervisor** per enabled instance row; reconfig = stop→start; `generation` counter no-ops stale callbacks; Backoff on fail(); command race COMMAND_TIMEOUT_MS 10s. States: configuring|connecting|online|degraded|offline|error|stopped.
- **Multiple instances:** N rows same typeId, no unique constraint. `InstanceDefinition {id,typeId,name,config,enabled,allowControl,simulate}`.
- **Persistence = SQLite (better-sqlite3 + Drizzle)**, config JSON-in-row, Zod validates on save + at supervisor start. Two DBs: `platform.db` (accounts/sessions/events) + per-event `events/<id>.db` (gear/groups/dashboards/history). Event switch = swap the event DB handle. Hand-written DDL migrations.
- **Simulator** per type: `simulate` bool → bind sim to 127.0.0.1:0, rewrite config via simulatedConfig(), connector speaks real protocol to fake device. Demo mode seeds one sim instance per type.
- **Realtime hub:** topics 3 closed shapes (mi:/sys:/usr:), whole-value snapshots cached (cheap reconnect), per-topic conflation by rateClass (fast100/normal1000/slow5000/change100), snapshot-on-subscribe. WS `/ws` @fastify/websocket, auth in preValidation, backpressure shed by bufferedAmount. Protocol v1 msgs: hello/snap/data/ack/err/pong/bye; client sub/unsub/cmd/ping.
- **Health engine** taps hub onPublish; conditions (offline/stale learned-interval + per-connector ConditionDecls) → alert RuleEngine → notify router (in-app usr:inbox + SMS outbox, mode severity floor). 
- **Auth:** roles viewer|operator|admin, fixed ACTIONS matrix; sessions = SHA-256 token hash, cookie stageit_session; device tokens (Bearer) for StreamDeck/Companion inherit NO user perms. Groups default-closed view/control; sys:* filtered per-subscriber fail-closed.
- **Command write path:** one audited pipeline (WS cmd + REST both use it): role→deviceGates(enabled+allowControl+declared+capabilities.control)→visibility.canControl→inputSchema.parse→exec. Every attempt incl refusals audited. `allowControl` per-instance is the master safety switch even for internal callers. Read-first by default.
- **OSC lib** hand-written (lib/osc.ts, OSC 1.0 + SLIP over TCP) used by QLab/Reaper/mic-cue.
- REST: /api/connector-types, /api/instances (CRUD + commands), /api/profiles (dashboards), /api/alert-rules, /api/metrics(+export.csv), /api/events, /api/running-order, /api/mic-cue-bindings, /api/devices/token, /api/mode, /api/settings, /api/notifications, /api/health.

## KEY DECISION for the plan (needs user): which foundation?
Dave's server (48k LOC) is far more capable than ours (multi-instance, sims, health, alerts, groups, audited commands, event-switch, profiles/surfaces). Options:
- **A. Host=ours, port Dave's connectors into our plain-JS/no-DB style.** Keeps our stack/Pi deploy; but ~= rewriting his 48k-line framework, high risk of losing functionality.
- **B. Host=Dave's server, restyle his Vite SPA to our look.** Keeps all functionality cheaply; "our UI" becomes a reskin, deploy model changes (SQLite/Fastify).
- **C. (recommend) Host=Dave's server as backend; rebuild OUR Next UI against his API/WS**, keeping our visual design + app-switcher, implement Surfaces via his profiles/widgets, port our 3 apps (ATEM engine, Timer Designer, Sennheiser-legacy) as connectors/app-pages. Best of both; still large.
