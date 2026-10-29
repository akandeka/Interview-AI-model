#!/usr/bin/env python3
"""
Native Wayland screenshot helper for OpenCluely.
Uses the XDG Desktop Portal Screenshot API with interactive=false
to capture the screen without showing a permission dialog.
"""

import sys
import os
import json
import shutil
import dbus
import dbus.mainloop.glib
from gi.repository import GLib

def main():
    if len(sys.argv) < 2:
        print("Usage: screenshot_helper.py <output_path.png>", file=sys.stderr)
        sys.exit(1)

    output_path = os.path.abspath(sys.argv[1])

    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SessionBus()

    try:
        portal = bus.get_object('org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop')
        iface = dbus.Interface(portal, 'org.freedesktop.portal.Screenshot')
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}), file=sys.stderr)
        sys.exit(1)

    loop = GLib.MainLoop()
    success = False

    def on_response(response, results):
        nonlocal success
        if response == 0 and 'uri' in results:
            uri = str(results['uri'])
            if uri.startswith('file://'):
                src_path = uri[7:]
                try:
                    shutil.copy2(src_path, output_path)
                    success = True
                    # Optionally remove the original if it was saved in a temp or Pictures dir
                    if '/Pictures/' in src_path or '/tmp/' in src_path:
                        try:
                            os.remove(src_path)
                        except:
                            pass
                except Exception as e:
                    pass
        loop.quit()

    bus.add_signal_receiver(on_response,
                            dbus_interface='org.freedesktop.portal.Request',
                            signal_name='Response')

    try:
        iface.Screenshot('', {'interactive': False})
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}), file=sys.stderr)
        sys.exit(1)

    # Timeout after 10 seconds
    GLib.timeout_add_seconds(10, loop.quit)
    loop.run()

    if success and os.path.exists(output_path):
        print(json.dumps({"success": True, "method": "portal", "path": output_path}))
        sys.exit(0)
    else:
        print(json.dumps({"success": False, "error": "Screenshot failed or timed out"}), file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    main()
