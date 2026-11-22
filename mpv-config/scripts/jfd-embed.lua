-- Jellyfin Desktop : mpv est intégré à la fenêtre de l'application (--wid).
-- Chromium place ses propres fenêtres de rendu au-dessus des autres fenêtres enfants ;
-- ce script remet la fenêtre vidéo de mpv au premier plan dès que nécessaire.
local wid = mp.get_property_number("wid", -1)
if not wid or wid <= 0 then return end

local ok, ffi = pcall(require, "ffi")
if not ok then
  mp.msg.warn("LuaJIT FFI indisponible : la vidéo peut être masquée par l'interface")
  return
end

ffi.cdef[[
typedef void* HWND;
int SetWindowPos(HWND hWnd, HWND hWndInsertAfter, int X, int Y, int cx, int cy, unsigned int uFlags);
HWND GetWindow(HWND hWnd, unsigned int uCmd);
]]
local user32 = ffi.load("user32")

local GW_HWNDPREV = 3
local SWP_NOSIZE, SWP_NOMOVE, SWP_NOACTIVATE = 0x0001, 0x0002, 0x0010
local FLAGS = SWP_NOSIZE + SWP_NOMOVE + SWP_NOACTIVATE

local function window()
  local id = mp.get_property_number("window-id")
  if not id or id == 0 then return nil end
  return ffi.cast("HWND", id)
end

local function raise()
  local h = window()
  if h == nil then return end
  -- Une fenêtre sœur au-dessus ? On repasse devant (HWND_TOP = NULL).
  if user32.GetWindow(h, GW_HWNDPREV) ~= nil then
    user32.SetWindowPos(h, nil, 0, 0, 0, 0, FLAGS)
  end
end

mp.observe_property("window-id", "native", raise)
mp.observe_property("osd-dimensions", "native", raise)
mp.register_event("file-loaded", raise)
mp.register_event("playback-restart", raise)
mp.add_periodic_timer(0.5, raise)
