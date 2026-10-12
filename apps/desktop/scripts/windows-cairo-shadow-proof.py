"""Own-process GTK/Cairo Win32 A8 failure reproduction, no installed-file writes."""
import argparse
import ctypes as C
import json
import os
import pathlib
import struct
import sys
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument("mode", nargs="?", default="halo-failed", choices=["normal", "blur-failed", "halo-failed"])
parser.add_argument("--dll-dir", required=True)
parser.add_argument("--output-dir")
args = parser.parse_args()
if sys.platform != "win32" or C.sizeof(C.c_void_p) != 8:
    raise SystemExit("This isolated diagnostic requires 64-bit Windows")
dll_dir = pathlib.Path(args.dll_dir).resolve()
if not all((dll_dir / name).is_file() for name in ["libcairo-2.dll", "libgtk-4-1.dll"]):
    raise SystemExit("Explicit packaged GTK/Cairo DLL directory is required")
output_dir = pathlib.Path(args.output_dir or tempfile.mkdtemp(prefix="rv-cairo-shadow-proof-")).resolve()
if output_dir == dll_dir.parent or dll_dir.parent in output_dir.parents:
    raise SystemExit("Refusing to write diagnostic output into the installed or packaged app")
output_dir.mkdir(parents=True, exist_ok=True)
os.add_dll_directory(str(dll_dir))
kernel = C.WinDLL("kernel32", use_last_error=True)
kernel.SetErrorMode.argtypes = [C.c_uint]
kernel.SetErrorMode.restype = C.c_uint
kernel.SetErrorMode(0x0001 | 0x0002)
kernel.VirtualProtect.argtypes = [C.c_void_p, C.c_size_t, C.c_uint32, C.POINTER(C.c_uint32)]
kernel.VirtualProtect.restype = C.c_int
kernel.SetLastError.argtypes = [C.c_uint32]
kernel.SetLastError.restype = None
kernel.AddVectoredExceptionHandler.argtypes = [C.c_uint32, C.c_void_p]
kernel.AddVectoredExceptionHandler.restype = C.c_void_p

def bind(lib, name, result, *arguments):
    function = getattr(lib, name)
    function.restype = result
    function.argtypes = list(arguments)
    return function

cairo = C.CDLL(str(dll_dir / "libcairo-2.dll"))
gtk = C.CDLL(str(dll_dir / "libgtk-4-1.dll"))
if not bind(gtk, "gtk_init_check", C.c_int)():
    raise SystemExit("GTK could not initialize its own display")
print(json.dumps({"stage": "initialized", "mode": args.mode,
                  "gtk": [bind(gtk, name, C.c_uint)() for name in
                          ["gtk_get_major_version", "gtk_get_minor_version", "gtk_get_micro_version"]]}), flush=True)

class Point(C.Structure):
    _fields_ = [("x", C.c_float), ("y", C.c_float)]
class Size(C.Structure):
    _fields_ = [("width", C.c_float), ("height", C.c_float)]
class Rect(C.Structure):
    _fields_ = [("origin", Point), ("size", Size)]
class Rounded(C.Structure):
    _fields_ = [("bounds", Rect), ("corner", Size * 4)]
class RGBA(C.Structure):
    _fields_ = [("red", C.c_float), ("green", C.c_float), ("blue", C.c_float), ("alpha", C.c_float)]

surface_new = bind(cairo, "cairo_win32_surface_create_with_dib", C.c_void_p, C.c_int, C.c_int, C.c_int)
surface_status = bind(cairo, "cairo_surface_status", C.c_int, C.c_void_p)
surface_destroy = bind(cairo, "cairo_surface_destroy", None, C.c_void_p)
context_new = bind(cairo, "cairo_create", C.c_void_p, C.c_void_p)
context_status = bind(cairo, "cairo_status", C.c_int, C.c_void_p)
context_destroy = bind(cairo, "cairo_destroy", None, C.c_void_p)
set_source = bind(cairo, "cairo_set_source_rgba", None, C.c_void_p, C.c_double, C.c_double, C.c_double, C.c_double)
paint = bind(cairo, "cairo_paint", None, C.c_void_p)
node_new = bind(gtk, "gsk_outset_shadow_node_new", C.c_void_p, C.POINTER(Rounded), C.POINTER(RGBA), C.c_float, C.c_float, C.c_float, C.c_float)
node_draw = bind(gtk, "gsk_render_node_draw", None, C.c_void_p, C.c_void_p)
node_unref = bind(gtk, "gsk_render_node_unref", None, C.c_void_p)
border_new = bind(gtk, "gsk_border_node_new", C.c_void_p, C.POINTER(Rounded), C.POINTER(C.c_float), C.POINTER(RGBA))
surface = surface_new(0, 160, 100)
if not surface or surface_status(surface):
    raise SystemExit("Normal finite Win32 target could not be created")
cr = context_new(surface)
if context_status(cr):
    raise SystemExit("Normal Win32 context could not be created")
set_source(cr, 0.05, 0.04, 0.09, 1.0)
paint(cr)

# Patch only the Cairo module's CreateDIBSection import in this process. This
# never opens another process or modifies the DLL on disk.
base = cairo._handle
def u16(offset): return C.c_uint16.from_address(base + offset).value
def u32(offset): return C.c_uint32.from_address(base + offset).value
def u64(offset): return C.c_uint64.from_address(base + offset).value
if u16(0) != 0x5A4D:
    raise SystemExit("Unexpected loaded PE image")
nt = u32(0x3C)
if u32(nt) != 0x4550 or u16(nt + 24) != 0x20B:
    raise SystemExit("Unexpected loaded PE64 image")
imports = u32(nt + 24 + 112 + 8)
iat_slot = None
descriptor = imports
while u32(descriptor + 12):
    names = u32(descriptor)
    addresses = u32(descriptor + 16)
    if names:
        index = 0
        while u64(names + index * 8):
            entry = u64(names + index * 8)
            if not entry & (1 << 63):
                name = C.string_at(base + entry + 2)
                if name == b"CreateDIBSection":
                    iat_slot = base + addresses + index * 8
                    break
            index += 1
    if iat_slot:
        break
    descriptor += 20
if iat_slot is None:
    raise SystemExit("Cairo did not import CreateDIBSection directly")
DIB = C.WINFUNCTYPE(C.c_void_p, C.c_void_p, C.c_void_p, C.c_uint, C.POINTER(C.c_void_p), C.c_void_p, C.c_uint32, use_last_error=True)
original_address = C.c_void_p.from_address(iat_slot).value
original_dib = DIB(original_address)
events = []
@DIB
def own_dib(hdc, info, usage, bits, section, offset):
    header = C.string_at(info, 40)
    width, height = struct.unpack_from("<ii", header, 4)
    bit_count = struct.unpack_from("<H", header, 14)[0]
    failed = args.mode != "normal" and bit_count == 8
    event = {"stage": "dib", "width": width, "height": height, "bits": bit_count, "failed": failed}
    events.append(event)
    print(json.dumps(event), flush=True)
    if failed:
        if bits:
            bits[0] = None
        C.set_last_error(87)
        return None
    return original_dib(hdc, info, usage, bits, section, offset)
callback_address = C.cast(own_dib, C.c_void_p).value
old_protect = C.c_uint32()
if not kernel.VirtualProtect(iat_slot, 8, 0x04, C.byref(old_protect)):
    raise C.WinError(C.get_last_error())
C.c_void_p.from_address(iat_slot).value = callback_address
ignored_protect = C.c_uint32()
kernel.VirtualProtect(iat_slot, 8, old_protect.value, C.byref(ignored_protect))
if args.mode == "halo-failed":
    # Prove the hook rejects a real, finite A8 allocation without sending that
    # failed surface into GTK's blur code. The mandatory gate never requires
    # a future GTK version to retain the historical null-context crash.
    probe = bind(cairo, "cairo_surface_create_similar_image", C.c_void_p,
                 C.c_void_p, C.c_int, C.c_int, C.c_int)(surface, 2, 8, 8)
    probe_status = surface_status(probe)
    surface_destroy(probe)
    assert probe_status != 0 and len(events) == 1 and events[0]["failed"]
    print(json.dumps({"stage": "fault_hook_verified", "surface_status": probe_status}), flush=True)
    events.clear()

class ExceptionRecord(C.Structure):
    _fields_ = [("code", C.c_uint32), ("flags", C.c_uint32),
                ("nested", C.c_void_p), ("address", C.c_void_p),
                ("parameter_count", C.c_uint32), ("information", C.c_size_t * 15)]
class ExceptionPointers(C.Structure):
    _fields_ = [("record", C.POINTER(ExceptionRecord)), ("context", C.c_void_p)]
VEH = C.WINFUNCTYPE(C.c_long, C.POINTER(ExceptionPointers))
@VEH
def own_exception(pointers):
    record = pointers.contents.record.contents
    if record.code == 0xC0000005:
        print(json.dumps({"stage": "access_violation", "address": hex(record.address),
                          "cairo_rva": hex(record.address - base),
                          "fault_address": hex(record.information[1]),
                          "rgba_setter_rva": hex(C.cast(set_source, C.c_void_p).value - base)}), flush=True)
    return 0  # Continue search; no masking, recovery or changes to execution.
own_handler = kernel.AddVectoredExceptionHandler(1, C.cast(own_exception, C.c_void_p))

outline = Rounded(Rect(Point(40, 30), Size(60, 40)), (Size * 4)(*[Size(8, 8) for _ in range(4)]))
color = RGBA(62 / 255, 214 / 255, 127 / 255, 0.55)
radius = 0.0 if args.mode == "halo-failed" else 22.0
spread = 1.0 if args.mode == "halo-failed" else 0.0
node = node_new(C.byref(outline), C.byref(color), 0.0, 0.0, spread, radius)
if not node:
    raise SystemExit("No render node")
print(json.dumps({"stage": "drawing", "radius": radius, "spread": spread,
                  "bounds": [40, 30, 60, 40]}), flush=True)
node_draw(node, cr)
if args.mode == "halo-failed":
    colors = (RGBA * 4)(*[RGBA(62 / 255, 214 / 255, 127 / 255, 1.0) for _ in range(4)])
    border = border_new(C.byref(outline), (C.c_float * 4)(2, 2, 2, 2), colors)
    node_draw(border, cr)
    node_unref(border)
    button_outline = Rounded(Rect(Point(110, 40), Size(24, 24)), (Size * 4)(*[Size(12, 12) for _ in range(4)]))
    feedback = RGBA(1.0, 95 / 255, 162 / 255, 0.7)
    button_shadow = node_new(C.byref(button_outline), C.byref(feedback), 0, 0, 1, 0)
    node_draw(button_shadow, cr)
    node_unref(button_shadow)
    bind(cairo, "cairo_surface_flush", None, C.c_void_p)(surface)
    image = bind(cairo, "cairo_win32_surface_get_image", C.c_void_p, C.c_void_p)(surface)
    pixel_data = bind(cairo, "cairo_image_surface_get_data", C.c_void_p, C.c_void_p)(image)
    stride = bind(cairo, "cairo_image_surface_get_stride", C.c_int, C.c_void_p)(image)
    def pixel(x, y):
        return list(C.string_at(pixel_data + y * stride + x * 4, 4))
    pixels = {"background": pixel(20, 20), "halo": pixel(39, 50),
              "speaking_border": pixel(40, 50), "button_feedback": pixel(109, 52)}
    assert pixels["halo"][1] > pixels["background"][1] + 50
    assert pixels["speaking_border"][1] > 200 and pixels["speaking_border"][2] < 80
    assert pixels["button_feedback"][2] > pixels["background"][2] + 100
    image_path = output_dir / "windows-zero-blur-feedback.png"
    image_status = bind(cairo, "cairo_surface_write_to_png", C.c_int, C.c_void_p, C.c_char_p)(surface, str(image_path).encode("utf-8"))
    assert image_status == 0
    print(json.dumps({"stage": "pixels", "bgra": pixels, "png": image_path.name}), flush=True)
status = context_status(cr)
print(json.dumps({"stage": "survived", "context_status": status, "dib_events": len(events),
                  "failed_masks": sum(event["failed"] for event in events)}), flush=True)
node_unref(node)
context_destroy(cr)
surface_destroy(surface)
if status:
    raise SystemExit("Cairo context failed")
if args.mode == "halo-failed":
    assert not events, "Zero-blur feedback must not allocate any Win32 A8 mask"
