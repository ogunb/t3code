import * as NodeEvents from "node:events";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Electron from "electron";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopTray from "./DesktopTray.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

class FakeWindow extends NodeEvents.EventEmitter {
  hidden = 0;
  hide() {
    this.hidden += 1;
  }
  closePrevented() {
    let prevented = false;
    this.emit("close", {
      preventDefault: () => {
        prevented = true;
      },
    });
    return prevented;
  }
  get window() {
    return this as unknown as Electron.BrowserWindow;
  }
}

function fixture(options: { platform?: string; failure?: string; failActivate?: boolean } = {}) {
  const app = new NodeEvents.EventEmitter();
  const tray = new NodeEvents.EventEmitter();
  const main = new FakeWindow();
  const other = new FakeWindow();
  let currentMain = main;
  let created = 0;
  let destroyed = 0;
  let activations = 0;
  let quits = 0;
  const warnings: unknown[] = [];
  let template: Electron.MenuItemConstructorOptions[] = [];
  const fail = (stage: string) => {
    if (options.failure === stage) throw new Error(stage);
  };
  const register = (event: string, listener: (...args: readonly unknown[]) => void) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        app.on(event, listener);
      }),
      () =>
        Effect.sync(() => {
          app.removeListener(event, listener);
        }),
    ).pipe(Effect.asVoid);
  const factory: DesktopTray.TrayFactory = {
    create: () => {
      created += 1;
      fail("constructor");
      return Object.assign(tray, {
        setToolTip: () => {
          fail("tooltip");
        },
        setContextMenu: () => {
          fail("context-menu");
        },
        isDestroyed: () => destroyed > 0,
        destroy: () => {
          destroyed += 1;
        },
        on: (event: string, listener: (...args: unknown[]) => void) => {
          fail("listeners");
          NodeEvents.EventEmitter.prototype.on.call(tray, event, listener);
          return tray;
        },
      }) as unknown as ReturnType<DesktopTray.TrayFactory["create"]>;
    },
    buildMenu: (items) => {
      fail("menu");
      template = items;
      return {} as Electron.Menu;
    },
    windows: () => [main.window, other.window],
  };
  const dependencies = Layer.mergeAll(
    Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
      platform: options.platform ?? "win32",
      displayName: "T3 Code",
    } as DesktopEnvironment.DesktopEnvironment["Service"]),
    Layer.succeed(DesktopAssets.DesktopAssets, {
      iconPaths: Effect.succeed({
        ico: options.failure === "missing" ? Option.none() : Option.some("brand.ico"),
        icns: Option.none(),
        png: Option.none(),
      }),
      resolveResourcePath: () => Effect.succeedNone,
    }),
    Layer.succeed(ElectronApp.ElectronApp, {
      ...ElectronApp.make,
      quit: Effect.sync(() => {
        quits += 1;
      }),
      on: (event, listener) => register(event, listener as (...args: readonly unknown[]) => void),
      onBeforeQuitForUpdate: (listener) => register("before-quit-for-update", listener),
    }),
    Layer.succeed(ElectronWindow.ElectronWindow, {
      main: Effect.sync(() => Option.some(currentMain.window)),
      create: () => Effect.die("unexpected create"),
      currentMainOrFirst: Effect.die("unexpected fallback"),
      focusedMainOrFirst: Effect.die("unexpected focus"),
      setMain: () => Effect.void,
      clearMain: () => Effect.void,
      prepareReveal: () => Effect.succeed(false),
      reveal: () => Effect.void,
      sendAll: () => Effect.void,
      destroyAll: Effect.void,
      syncAllAppearance: () => Effect.void,
    }),
    Layer.succeed(DesktopWindow.DesktopWindow, {
      createMain: Effect.die("unexpected create"),
      ensureMain: Effect.die("unexpected ensure"),
      revealOrCreateMain: Effect.die("unexpected reveal"),
      createMainIfBackendReady: Effect.void,
      showConnectingSplash: Effect.void,
      handleBackendReady: () => Effect.void,
      handleBackendNotReady: Effect.void,
      flushMainWindowBounds: Effect.void,
      prepareCaptureReveal: Effect.void,
      dispatchMenuAction: () => Effect.void,
      dispatchSnapShotEvent: () => Effect.void,
      zoomMain: () => Effect.void,
      runMainContentsCommand: () => Effect.void,
      syncAppearance: Effect.void,
      activate: Effect.sync(() => {
        activations += 1;
        if (options.failActivate) throw new Error("activate");
      }),
    }),
    DesktopState.layer,
    Logger.layer([
      Logger.make((entry) => {
        warnings.push(entry.message);
      }),
    ]),
  );
  return {
    app,
    tray,
    main,
    other,
    warnings,
    configure: DesktopTray.make(factory).configure,
    provide: Effect.provide(dependencies),
    counts: () => ({ created, destroyed, activations, quits }),
    setMain: (window: FakeWindow) => {
      currentMain = window;
    },
    action: (index: number) => {
      const click = template[index]?.click;
      assert.isDefined(click);
      return (click as unknown as () => Promise<unknown>)();
    },
    trayAction: (event: string) => {
      const callback = tray.listeners(event)[0];
      assert.isDefined(callback);
      return (callback as () => Promise<unknown>)();
    },
  };
}

describe("DesktopTray", () => {
  it("hides only for the Windows main window with a ready tray and no quit intent", () => {
    for (const platform of ["win32", "linux", "darwin"]) {
      for (const trayReady of [true, false]) {
        for (const isMainWindow of [true, false]) {
          for (const quitRequested of [true, false]) {
            for (const quitting of [true, false]) {
              assert.equal(
                DesktopTray.resolveTrayCloseAction({
                  platform,
                  trayReady,
                  isMainWindow,
                  quitRequested,
                  quitting,
                }),
                platform === "win32" && trayReady && isMainWindow && !quitRequested && !quitting
                  ? "hide"
                  : "close",
              );
            }
          }
        }
      }
    }
  });

  it.effect.each(["linux", "darwin"])("does nothing on %s", (platform) => {
    const f = fixture({ platform });
    return Effect.scoped(
      Effect.gen(function* () {
        yield* f.configure;
        assert.equal(f.counts().created, 0);
        assert.deepEqual(f.app.eventNames(), []);
        assert.deepEqual(f.main.eventNames(), []);
      }),
    ).pipe(f.provide);
  });

  it.effect.each(["missing", "constructor", "tooltip", "menu", "context-menu", "listeners"])(
    "falls back to closing when %s fails",
    (failure) => {
      const f = fixture({ failure });
      return Effect.scoped(
        Effect.gen(function* () {
          yield* f.configure;
          assert.isFalse(f.main.closePrevented());
          assert.equal(f.main.listenerCount("close"), 0);
          assert.equal(f.counts().destroyed, ["missing", "constructor"].includes(failure) ? 0 : 1);
          assert.isAbove(f.warnings.length, 0);
        }),
      ).pipe(f.provide);
    },
  );

  it.effect.each(["before-quit", "before-quit-for-update", "session-end"])(
    "allows closing after %s",
    (event) => {
      const f = fixture();
      return Effect.scoped(
        Effect.gen(function* () {
          yield* f.configure;
          if (event === "session-end") f.main.emit(event);
          else f.app.emit(event);
          assert.isFalse(f.main.closePrevented());
          assert.equal(f.counts().destroyed, event === "before-quit-for-update" ? 1 : 0);
          assert.equal(f.counts().quits, event === "session-end" ? 1 : 0);
        }),
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            assert.equal(f.counts().destroyed, 1);
          }),
        ),
        f.provide,
      );
    },
  );

  it.effect(
    "hides only the current main, wires future windows, and cleans up on scope close",
    () => {
      const f = fixture();
      const future = new FakeWindow();
      return Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* f.configure;
            assert.isTrue(f.main.closePrevented());
            assert.equal(f.main.hidden, 1);
            assert.isFalse(f.other.closePrevented());
            f.other.emit("session-end");
            assert.equal(f.counts().quits, 0);
            f.app.emit("browser-window-created", {}, future.window);
            f.setMain(future);
            assert.isFalse(f.main.closePrevented());
            assert.isTrue(future.closePrevented());
            const state = yield* DesktopState.DesktopState;
            yield* Ref.set(state.quitting, true);
            assert.isFalse(future.closePrevented());
          }),
        );
        assert.equal(f.counts().destroyed, 1);
        assert.deepEqual(f.app.eventNames(), []);
        assert.deepEqual(f.main.eventNames(), []);
        assert.deepEqual(future.eventNames(), []);
      }).pipe(f.provide);
    },
  );

  it.effect.each([false, true])(
    "runs tray actions and contains activation defects (failure=%s)",
    (failActivate) => {
      const f = fixture({ failActivate });
      return Effect.scoped(
        Effect.gen(function* () {
          yield* f.configure;
          yield* Effect.promise(() => f.action(0));
          yield* Effect.promise(() => f.trayAction("click"));
          yield* Effect.promise(() => f.trayAction("double-click"));
          yield* Effect.promise(() => f.action(2));
          assert.equal(f.counts().activations, 3);
          assert.equal(f.counts().quits, 1);
          assert.equal(f.warnings.length, failActivate ? 3 : 0);
        }),
      ).pipe(f.provide);
    },
  );
});
