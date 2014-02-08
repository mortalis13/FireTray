/* -*- Mode: js2; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */

/* The tray icon for the main app. We need a hidden proxy window as (1) we want
 a unique icon, (2) the icon sends notifications to a single window. */

var EXPORTED_SYMBOLS = [ "firetray" ];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/ctypes.jsm");
Cu.import("resource://firetray/ctypes/ctypesMap.jsm");
Cu.import("resource://firetray/ctypes/winnt/win32.jsm");
Cu.import("resource://firetray/ctypes/winnt/kernel32.jsm");
Cu.import("resource://firetray/ctypes/winnt/shell32.jsm");
Cu.import("resource://firetray/ctypes/winnt/user32.jsm");
Cu.import("resource://firetray/winnt/FiretrayWin32.jsm");
Cu.import("resource://firetray/commons.js");
firetray.Handler.subscribeLibsForClosing([kernel32, shell32, user32]);

let log = firetray.Logging.getLogger("firetray.StatusIcon");

if ("undefined" == typeof(firetray.Handler))
  log.error("This module MUST be imported from/after FiretrayHandler !");

FIRETRAY_ICON_CHROME_PATHS = {
  'mail-unread': "chrome://firetray/skin/winnt/mail-unread.ico",
};

firetray.StatusIcon = {
  initialized: false,
  callbacks: {}, // pointers to JS functions. MUST LIVE DURING ALL THE EXECUTION
  notifyIconData: null,
  hwndProxy: null,
  icons: null,
  WNDCLASS_NAME: "FireTrayHiddenWindowClass",
  WNDCLASS_ATOM: null,

  init: function() {
    this.loadIcons();
    // this.defineIconNames();     // FIXME: linux-only
    this.create();

    this.initialized = true;
    return true;
  },

  shutdown: function() {
    log.debug("Disabling StatusIcon");

    this.destroy();
    this.destroyIcons();

    this.initialized = false;
    return true;
  },

  defineIconNames: function() { // FIXME: linux-only
    this.prefAppIconNames = (function() {
      if (firetray.Handler.inMailApp) {
        return "app_mail_icon_names";
      } else if (firetray.Handler.inBrowserApp) {
        return "app_browser_icon_names";
      } else {
        return "app_default_icon_names";
      }
    })();
    this.defaultAppIconName = firetray.Handler.appName.toLowerCase();

    this.prefNewMailIconNames = "new_mail_icon_names";
    this.defaultNewMailIconName = "mail-unread";
  },

  loadIcons: function() {
    this.icons = new ctypesMap(win32.HICON);

    // the Mozilla hidden window has the default Mozilla icon
    let hwnd_hidden_moz = user32.FindWindowW("MozillaHiddenWindowClass", null);
    log.debug("=== hwnd_hidden_moz="+hwnd_hidden_moz);
    this.icons.insert('app', this.getIconFromWindow(hwnd_hidden_moz));

    /* we'll take the first icon in the .ico file. To get the icon count in the
     file, pass ctypes.cast(ctypes.int(-1), win32.UINT); */
    for (let ico_name in FIRETRAY_ICON_CHROME_PATHS) {
      let path = firetray.Utils.chromeToPath(FIRETRAY_ICON_CHROME_PATHS[ico_name]);
      let hicon = shell32.ExtractIconW(null, path, 0);
      // ERROR_INVALID_HANDLE(6) ignored (_Reserved_ HINSTANCE hInst ?)
      this.icons.insert(ico_name, hicon);
      log.debug("icon '"+ico_name+"'="+this.icons.get(ico_name)+" winLastError="+ctypes.winLastError);
    }
  },

  destroyIcons: function() {
    let success = true, errors = [];
    let keys = this.icons.keys;

    // 'app' must not get DestroyIcon'd
    var idx_app = keys.indexOf('app');
    if (idx_app > -1) keys.splice(idx_app, 1);

    for (let i=0, len=keys.length; i<len; ++i) {
      let ico_name = keys[i];
      let res = user32.DestroyIcon(this.icons.get(ico_name));
      if (res)
        this.icons.remove(ico_name);
      else
        errors.push(ctypes.winLastError);
      success = success && res;
    }
    this.icons.remove('app');

    if (!success) {
      log.error("Couldn't destroy all icons: "+errors);
    } else {
      log.debug("Icons destroyed");
    }
  },

  create: function() {
    let hwnd_hidden = this.createProxyWindow();

    nid = new shell32.NOTIFYICONDATAW();
    nid.cbSize = shell32.NOTIFYICONDATAW_SIZE();
    log.debug("SIZE="+nid.cbSize);
    nid.szTip = firetray.Handler.appName;
    nid.hIcon = this.icons.get('app');
    nid.hWnd = hwnd_hidden;
    nid.uCallbackMessage = firetray.Win32.WM_TRAYMESSAGE;
    nid.uFlags = shell32.NIF_ICON | shell32.NIF_MESSAGE | shell32.NIF_TIP;
    nid.uVersion = shell32.NOTIFYICON_VERSION_4;

    // Install the icon
    rv = shell32.Shell_NotifyIconW(shell32.NIM_ADD, nid.address());
    log.debug("Shell_NotifyIcon ADD="+rv+" winLastError="+ctypes.winLastError); // ERROR_INVALID_WINDOW_HANDLE(1400)
    rv = shell32.Shell_NotifyIconW(shell32.NIM_SETVERSION, nid.address());
    log.debug("Shell_NotifyIcon SETVERSION="+rv+" winLastError="+ctypes.winLastError);

    this.notifyIconData = nid;
    this.hwndProxy = hwnd_hidden;
  },

  createProxyWindow: function() {
    this.registerWindowClass();

    let hwnd_hidden = user32.CreateWindowExW(
      0, win32.LPCTSTR(this.WNDCLASS_ATOM), // lpClassName can also be _T(WNDCLASS_NAME)
      "Firetray Message Window", 0,
      user32.CW_USEDEFAULT, user32.CW_USEDEFAULT, user32.CW_USEDEFAULT, user32.CW_USEDEFAULT,
      null, null, firetray.Win32.hInstance, null);
    log.debug("CreateWindow="+!hwnd_hidden.isNull()+" winLastError="+ctypes.winLastError);

    this.callbacks.proxyWndProc = user32.WNDPROC(firetray.StatusIcon.proxyWndProc);
    let procPrev = user32.SetWindowLongW(hwnd_hidden, user32.GWLP_WNDPROC,
      ctypes.cast(this.callbacks.proxyWndProc, win32.LONG_PTR));
    log.debug("procPrev="+procPrev+" winLastError="+ctypes.winLastError);

    firetray.Win32.acceptAllMessages(hwnd_hidden);

    return hwnd_hidden;
  },

  registerWindowClass: function() {
    let wndClass = new user32.WNDCLASSEXW();
    wndClass.cbSize = user32.WNDCLASSEXW.size;
    wndClass.lpfnWndProc = ctypes.cast(user32.DefWindowProcW, user32.WNDPROC);
    wndClass.hInstance = firetray.Win32.hInstance;
    wndClass.lpszClassName = win32._T(this.WNDCLASS_NAME);
    this.WNDCLASS_ATOM = user32.RegisterClassExW(wndClass.address());
    log.debug("WNDCLASS_ATOM="+this.WNDCLASS_ATOM);
  },

  proxyWndProc: function(hWnd, uMsg, wParam, lParam) {
    // log.debug("ProxyWindowProc CALLED: hWnd="+hWnd+", uMsg="+uMsg+", wParam="+wParam+", lParam="+lParam);

    if (uMsg === firetray.Win32.WM_TASKBARCREATED) {
      log.info("____________TASKBARCREATED");

    } else if (uMsg === firetray.Win32.WM_TRAYMESSAGEFWD) {
      log.debug("ProxyWindowProc WM_TRAYMESSAGEFWD reached!");

    } else if (uMsg === firetray.Win32.WM_TRAYMESSAGE) {

      switch (+lParam) {
      case win32.WM_LBUTTONUP:
        log.debug("WM_LBUTTONUP");
        firetray.Handler.showHideAllWindows();
        break;
      case win32.WM_RBUTTONUP:
        log.debug("WM_RBUTTONUP");
        firetray.Handler.windowGetAttention(); // TESTING
        break;
      case win32.WM_CONTEXTMENU:
        log.debug("WM_CONTEXTMENU");
        break;
      case win32.NIN_KEYSELECT:
        log.debug("NIN_KEYSELECT");
        break;
      default:
      }

    }

    return user32.DefWindowProcW(hWnd, uMsg, wParam, lParam);
  },

  getIconFromWindow: function(hwnd) {
    let rv = user32.SendMessageW(hwnd, user32.WM_GETICON, user32.ICON_SMALL, 0);
    log.debug("SendMessageW winLastError="+ctypes.winLastError);
    // result is a ctypes.Int64. So we need to create a CData from it before
    // casting it to a HICON.
    let icon = ctypes.cast(win32.LRESULT(rv), win32.HICON);
    let NULL = win32.HICON(null); // for comparison only
    if (firetray.js.strEquals(icon, NULL)) { // from the window class
      rv = user32.GetClassLong(hwnd, user32.GCLP_HICONSM);
      icon = ctypes.cast(win32.ULONG_PTR(rv), win32.HICON);
      log.debug("GetClassLong winLastError="+ctypes.winLastError);
    }
    if (firetray.js.strEquals(icon, NULL)) { // from the first resource -> ERROR_RESOURCE_TYPE_NOT_FOUND(1813)
      icon = user32.LoadIconW(firetray.Win32.hInstance, win32.MAKEINTRESOURCE(0));
      log.debug("LoadIconW module winLastError="+ctypes.winLastError);
    }
    if (firetray.js.strEquals(icon, NULL)) { // OS default icon
      icon = user32.LoadIconW(null, win32.MAKEINTRESOURCE(user32.IDI_APPLICATION));
      log.debug("LoadIconW default winLastError="+ctypes.winLastError);
    }
    log.debug("=== icon="+icon);
    return icon;
  },

  destroyProxyWindow: function() {
    let rv = user32.DestroyWindow(this.hwndProxy);

    rv = this.unregisterWindowClass();
    log.debug("Hidden window removed");
  },

  unregisterWindowClass: function() {
    return user32.UnregisterClassW(win32.LPCTSTR(this.WNDCLASS_ATOM), firetray.Win32.hInstance);
  },

  destroy: function() {
    let rv = shell32.Shell_NotifyIconW(shell32.NIM_DELETE, this.notifyIconData.address());
    log.debug("Shell_NotifyIcon DELETE="+rv+" winLastError="+ctypes.winLastError);
    this.destroyProxyWindow();
  },

  setImageFromIcon: function(icoName) {
    let nid = firetray.StatusIcon.notifyIconData;
    nid.hIcon = firetray.StatusIcon.icons.get(icoName);
    rv = shell32.Shell_NotifyIconW(shell32.NIM_MODIFY, nid.address());
    log.debug("Shell_NotifyIcon MODIFY="+rv+" winLastError="+ctypes.winLastError);
  }

}; // firetray.StatusIcon

firetray.Handler.setIconImageDefault = function() {
  log.debug("setIconImageDefault");
  firetray.StatusIcon.setImageFromIcon('app');
};

firetray.Handler.setIconImageNewMail = function() {
  firetray.StatusIcon.setImageFromIcon('mail-unread');
};

// firetray.Handler.setIconImageFromFile = firetray.StatusIcon.setIconImageFromFile;

firetray.Handler.setIconTooltip = function(toolTipStr) {
};

firetray.Handler.setIconTooltipDefault = function() {
};

firetray.Handler.setIconText = function(text, color) {
};

firetray.Handler.setIconVisibility = function(visible) {
};
