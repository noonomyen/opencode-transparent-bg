import {
  BoxRenderable,
  DiffRenderable,
  OptimizedBuffer,
  RGBA,
  Renderable,
  ScrollBoxRenderable,
  type BaseRenderable,
  type CliRenderer,
} from "@opentui/core"
import type { Plugin } from "@opencode/plugin/tui"

export default {
  id: "transparent-bg",
  setup(
    api: Pick<Plugin.Context, "renderer" | "theme" | "options"> & {
      keymap?: Pick<Plugin.Context["keymap"], "mode">
    },
  ) {
    const renderer = api.renderer
    const root = renderer.root
    const transparent = RGBA.fromInts(0, 0, 0, 0)
    const preserveIds = Array.isArray(api.options.preserveIds)
      ? api.options.preserveIds.filter((id): id is string => typeof id === "string")
      : []
    const hooks = new Map<Renderable, { current: Renderable["render"]; descriptor?: PropertyDescriptor }>()
    const completions = new Set<Renderable>()
    const backgroundDescriptor = Object.getOwnPropertyDescriptor(renderer, "setBackgroundColor")
    const renderDescriptor = Object.getOwnPropertyDescriptor(root, "render")
    const setBackground = renderer.setBackgroundColor.bind(renderer)
    const render = root.render.bind(root)
    const initialBackground: unknown = Reflect.get(renderer, "backgroundColor")
    let background: Parameters<CliRenderer["setBackgroundColor"]>[0] =
      initialBackground instanceof RGBA ? initialBackground : api.theme.background.base
    let active = true
    const palettes = new Map<number, Set<number>>()
    const scissors: Parameters<OptimizedBuffer["pushScissorRect"]>[] = []

    const data = renderer.nextRenderBuffer.buffers
    if (
      !(data.bg instanceof Uint16Array) ||
      !(data.fg instanceof Uint16Array) ||
      !(data.char instanceof Uint32Array) ||
      data.bg.length !== renderer.width * renderer.height * 4 ||
      data.fg.length !== data.bg.length ||
      data.char.length * 4 !== data.bg.length
    ) {
      throw new Error("transparent-bg requires OpenTUI's packed RGBA buffer layout (tested on 0.5.14)")
    }
    const sample = OptimizedBuffer.create(1, 1, renderer.widthMethod, {
      respectAlpha: true,
    })
    const backdrop = RGBA.fromInts(0, 0, 0)

    function colorKeys(color: RGBA, opacity: number) {
      // The renderer uses opaque RGB from its transparent background as the blend
      // backdrop. Sample that native composite too, without duplicating its math.
      sample.clear(backdrop)
      sample.pushOpacity(opacity)
      sample.drawBox({
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        border: false,
        borderColor: transparent,
        backgroundColor: color,
        shouldFill: true,
      })
      sample.popOpacity()
      return [colorKey(color), colorKey(RGBA.fromArray(sample.buffers.bg))]
    }

    function setBackgroundColor(color: Parameters<CliRenderer["setBackgroundColor"]>[0]) {
      background = color
      setBackground(active ? transparent : color)
    }

    function surfaceColors(opacity: number) {
      const cached = palettes.get(opacity)
      if (cached) return cached
      const theme = api.theme
      const accents = new Set(
        [
          theme.text.action.primary.selected,
          theme.background.action.primary.focused,
          theme.background.action.primary.selected,
          theme.background.action.destructive.base,
          theme.background.action.destructive.focused,
          theme.background.action.destructive.selected,
          ...Object.values(theme.text.feedback).map((color) => color.base),
        ]
          .filter((color) => color.a > 0)
          .flatMap((color) => colorKeys(color, opacity)),
      )
      const surfaces = new Set(
        [
          theme.background.base,
          ...Object.values(theme.background.raised),
          ...Object.values(theme.background.formfield).filter((color): color is RGBA => color instanceof RGBA),
        ]
          .flatMap((color) => colorKeys(color, opacity))
          .filter((color) => !accents.has(color)),
      )
      palettes.set(opacity, surfaces)
      return surfaces
    }

    function renderRoot(buffer: OptimizedBuffer, deltaTime: number) {
      if (!active) return render(buffer, deltaTime)
      palettes.clear()
      const seen = new Set<Renderable>()
      const autocomplete = api.keymap?.mode.current() === "autocomplete"
      completions.clear()
      function visit(node: BaseRenderable) {
        if (node instanceof Renderable) seen.add(node)
        // Completion boxes have generated IDs. Match the active input mode and
        // its absolute list layer instead of tying transparency to those IDs.
        if (
          autocomplete &&
          node instanceof BoxRenderable &&
          Reflect.get(node, "_positionType") === "absolute" &&
          node.zIndex === 100 &&
          node.getChildren().some((child) => child instanceof ScrollBoxRenderable)
        ) {
          completions.add(node)
        }
        // Inline TextNodeRenderable children are drawn by their text parent.
        if (node instanceof Renderable && !hooks.has(node)) {
          const native = node.render === Renderable.prototype.render
          const previous = node.render.bind(node)
          const descriptor = Object.getOwnPropertyDescriptor(node, "render")
          // Native text and editor renderables have their own render paths.
          // Wrap the instance's complete draw so native text backgrounds are covered too.
          const current: Renderable["render"] = (buffer, deltaTime) => {
            if (active && isBackdrop(node, renderer) && !preserved(node, preserveIds, completions, true)) {
              const fill = node.shouldFill
              // Skip dimming before alpha blending changes the underlying text.
              // Keep render() running so the backdrop still receives outside clicks.
              node.shouldFill = false
              try {
                previous(buffer, deltaTime)
              } finally {
                node.shouldFill = fill
              }
              return
            }
            // Plain layout boxes do not paint cells. Scanning their rectangle
            // could erase an earlier overlay even though this draw changed nothing.
            const empty =
              Object.getPrototypeOf(node) === BoxRenderable.prototype &&
              node instanceof BoxRenderable &&
              native &&
              !Object.hasOwn(node, "renderSelf") &&
              !node.renderBefore &&
              !node.renderAfter &&
              !node.border &&
              (!node.shouldFill || node.backgroundColor.a === 0)
            previous(buffer, deltaTime)
            if (!active || empty || preserved(node, preserveIds, completions)) return
            const opacity = buffer.getCurrentOpacity()
            if (opacity === 0) return
            stripBackground(buffer, node, surfaceColors(opacity), scissors.at(-1))
          }
          node.render = current
          hooks.set(node, { current, descriptor })
        }
        node.getChildren().forEach(visit)
      }
      root.getChildren().forEach(visit)
      hooks.forEach((hook, node) => {
        if (seen.has(node)) return
        if (node.render === hook.current) {
          if (hook.descriptor) Object.defineProperty(node, "render", hook.descriptor)
          if (!hook.descriptor) Reflect.deleteProperty(node, "render")
        }
        hooks.delete(node)
      })
      return withClipping(buffer, scissors, () => render(buffer, deltaTime))
    }

    function cleanup() {
      if (!active) return
      active = false
      hooks.forEach((hook, node) => {
        if (node.render === hook.current) {
          if (hook.descriptor) Object.defineProperty(node, "render", hook.descriptor)
          if (!hook.descriptor) Reflect.deleteProperty(node, "render")
        }
      })
      hooks.clear()
      completions.clear()
      palettes.clear()
      sample.destroy()
      if (root.render === renderRoot) {
        if (renderDescriptor) Object.defineProperty(root, "render", renderDescriptor)
        if (!renderDescriptor) Reflect.deleteProperty(root, "render")
      }
      if (renderer.setBackgroundColor === setBackgroundColor) {
        if (backgroundDescriptor) Object.defineProperty(renderer, "setBackgroundColor", backgroundDescriptor)
        if (!backgroundDescriptor) Reflect.deleteProperty(renderer, "setBackgroundColor")
      }
      if (!renderer.isDestroyed) renderer.setBackgroundColor(background)
    }

    try {
      renderer.setBackgroundColor = setBackgroundColor
      root.render = renderRoot
      setBackground(transparent)
    } catch (error) {
      try {
        cleanup()
      } catch (rollback) {
        const failure = new AggregateError(
          [error, rollback],
          "transparent-bg setup and background restoration failed",
          {
            cause: rollback,
          },
        )
        throw failure
      }
      throw error
    }
    return cleanup
  },
} satisfies Plugin.Definition

function colorKey(color: RGBA) {
  return ((color.buffer[0] & 255) << 16) | ((color.buffer[1] & 255) << 8) | (color.buffer[2] & 255)
}

function isBackdrop(node: Renderable, renderer: CliRenderer): node is BoxRenderable {
  return (
    node instanceof BoxRenderable &&
    Reflect.get(node, "_positionType") === "absolute" &&
    node.screenX <= 0 &&
    node.screenY <= 0 &&
    node.screenX + node.width >= renderer.width &&
    node.screenY + node.height >= renderer.height &&
    node.backgroundColor.r === 0 &&
    node.backgroundColor.g === 0 &&
    node.backgroundColor.b === 0 &&
    node.backgroundColor.a > 0 &&
    node.backgroundColor.a < 1
  )
}

function preserved(node: Renderable, ids: string[], completions: Set<Renderable>, explicit = false): boolean {
  if (ids.includes(node.id)) return true
  if (!explicit && node instanceof DiffRenderable) return true
  // OpenTUI exposes position as a setter only. Its stored value distinguishes
  // overlays from ordinary docked UI, including the sidebar.
  if (!explicit && !completions.has(node) && (Reflect.get(node, "_positionType") === "absolute" || node.zIndex >= 2500))
    return true
  return node.parent ? preserved(node.parent, ids, completions, explicit) : false
}

function withClipping(
  buffer: OptimizedBuffer,
  scissors: Parameters<OptimizedBuffer["pushScissorRect"]>[],
  render: () => void,
) {
  const methods = ["pushScissorRect", "popScissorRect", "clearScissorRects"] as const
  const descriptors = methods.map((key) => Object.getOwnPropertyDescriptor(buffer, key))
  const push = buffer.pushScissorRect.bind(buffer)
  const pop = buffer.popScissorRect.bind(buffer)
  const clear = buffer.clearScissorRects.bind(buffer)
  // Raw buffer writes bypass native scissoring. Track the public stack during
  // this frame so clipping includes borders and custom viewport rectangles.
  const wrappers = [
    (x: number, y: number, width: number, height: number) => {
      push(x, y, width, height)
      const previous = scissors.at(-1)
      const left = Math.max(0, Math.trunc(x), previous?.[0] ?? 0)
      const top = Math.max(0, Math.trunc(y), previous?.[1] ?? 0)
      const right = Math.min(
        buffer.width,
        Math.trunc(x) + Math.trunc(width),
        previous ? previous[0] + previous[2] : buffer.width,
      )
      const bottom = Math.min(
        buffer.height,
        Math.trunc(y) + Math.trunc(height),
        previous ? previous[1] + previous[3] : buffer.height,
      )
      scissors.push([left, top, Math.max(0, right - left), Math.max(0, bottom - top)])
    },
    () => {
      pop()
      scissors.pop()
    },
    () => {
      clear()
      scissors.length = 0
    },
  ] as const
  buffer.pushScissorRect = wrappers[0]
  buffer.popScissorRect = wrappers[1]
  buffer.clearScissorRects = wrappers[2]
  try {
    render()
  } finally {
    methods.forEach((key, index) => {
      if (Reflect.get(buffer, key) !== wrappers[index]) return
      const descriptor = descriptors[index]
      if (descriptor) Object.defineProperty(buffer, key, descriptor)
      if (!descriptor) Reflect.deleteProperty(buffer, key)
    })
    scissors.length = 0
  }
}

function stripBackground(
  buffer: OptimizedBuffer,
  node: Renderable,
  surfaces: Set<number>,
  clip?: Parameters<OptimizedBuffer["pushScissorRect"]>,
) {
  const data = buffer.buffers
  // Native drawing converts coordinates to integers at the FFI boundary.
  const x = Math.trunc(node.screenX)
  const y = Math.trunc(node.screenY)
  const width = Math.trunc(node.width)
  const height = Math.trunc(node.height)
  // A complete render() has already composited any local framebuffer into this buffer.
  const left = Math.max(0, x, clip?.[0] ?? 0)
  const top = Math.max(0, y, clip?.[1] ?? 0)
  const right = Math.min(buffer.width, x + width, clip ? clip[0] + clip[2] : buffer.width)
  const bottom = Math.min(buffer.height, y + height, clip ? clip[1] + clip[3] : buffer.height)
  const horizontal = node instanceof BoxRenderable && ["▀", "▄"].includes(node.customBorderChars?.horizontal ?? "")
  const vertical = node instanceof BoxRenderable && node.customBorderChars?.vertical === "╹"

  for (let row = top; row < bottom; row++) {
    for (let column = left; column < right; column++) {
      const cell = row * buffer.width + column
      const offset = cell * 4
      if (
        (data.bg[offset + 3] & 255) !== 0 &&
        surfaces.has(((data.bg[offset] & 255) << 16) | ((data.bg[offset + 1] & 255) << 8) | (data.bg[offset + 2] & 255))
      ) {
        data.bg.fill(0, offset, offset + 4)
      }
      // The prompt paints its edge as a custom border, not a background. Unicode
      // text uses pooled glyph IDs, so identify these decorations from Box options.
      if (
        ((horizontal &&
          (row === y || row === y + height - 1) &&
          data.char[cell] === node.customBorderChars?.horizontal?.codePointAt(0)) ||
          (vertical && (column === x || column === x + width - 1) && data.char[cell] === "╹".codePointAt(0))) &&
        surfaces.has(((data.fg[offset] & 255) << 16) | ((data.fg[offset + 1] & 255) << 8) | (data.fg[offset + 2] & 255))
      ) {
        data.char[cell] = 32
      }
    }
  }
}
