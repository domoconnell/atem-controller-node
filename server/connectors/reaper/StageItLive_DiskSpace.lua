--[[
  StageItLive_DiskSpace.lua

  Publishes REAPER's free disk space at the current record path so the Stage It
  Live dashboard can show it. REAPER's web remote can read extended state but
  has no command for free space, so this script is the only way the number gets
  out of REAPER at all.

  Install
    1. Actions → Show action list… → New action → Load ReaScript…
    2. Pick this file. It appears in the action list as
       "Script: StageItLive_DiskSpace.lua".
    3. Run it once. It keeps running in the background until REAPER quits or
       you run it again (running it a second time stops the first copy).

  Run it every show
    Either run it by hand as part of load-in, or — better, because nobody
    remembers at 11pm — have it start with the project:
      · SWS extension: SWS → Startup actions → Set global startup action,
        and pick this script; or
      · put the project in a template that has the action bound to a toolbar
        button the record op presses with everything else.

  Without this script running, the dashboard's disk widget simply stays blank.
  Nothing else about the REAPER connector depends on it.
]]

local SECTION = 'StageItLive'
local KEY = 'disk_free_mb'

-- Free space moves slowly even while recording 64 channels, and a defer loop
-- that hits the filesystem every 30ms would show up in REAPER's performance
-- meter during a set. Once every few seconds is plenty.
local UPDATE_INTERVAL_SECONDS = 5

local next_update = 0

local function tick()
  local now = reaper.time_precise()
  if now >= next_update then
    next_update = now + UPDATE_INTERVAL_SECONDS
    -- 0 = the active project. Returns whole megabytes.
    local mb = reaper.GetFreeDiskSpaceForRecordPath(0)
    -- persist = false: this is live telemetry, not something to restore from
    -- reaper.ini next launch, where it would be a stale number nobody notices.
    reaper.SetExtState(SECTION, KEY, tostring(mb), false)
  end
  reaper.defer(tick)
end

-- A number left behind after the script stops would look live on the wall
-- forever. Better for the widget to go blank and say so.
reaper.atexit(function()
  reaper.DeleteExtState(SECTION, KEY, false)
end)

tick()
