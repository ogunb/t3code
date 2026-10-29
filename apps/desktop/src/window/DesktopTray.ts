import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import * as Electron from "electron";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

export function resolveTrayCloseAction(input: {
  readonly platform: string;
  readonly trayReady: boolean;
  readonly isMainWindow: boolean;
  readonly quitRequested: boolean;
  readonly quitting: boolean;
}): "hide" | "close" {
  return input.platform === "win32" &&
    input.trayReady &&
    input.isMainWindow &&
    !input.quitRequested &&
    !input.quitting
    ? "hide"
    : "close";
}

export interface TrayFactory {
  readonly create: (
    iconPath: string,
  ) => Pick<Electron.Tray, "setToolTip" | "setContextMenu" | "on" | "destroy" | "isDestroyed">;
  readonly buildMenu: (template: Electron.MenuItemConstructorOptions[]) => Electron.Menu;
  readonly windows: () => Electron.BrowserWindow[];
}

const electronFactory: TrayFactory = {
  create: (iconPath) => new Electron.Tray(Electron.nativeImage.createFromPath(iconPath)),
  buildMenu: (template) => Electron.Menu.buildFromTemplate(template),
  windows: () => Electron.BrowserWindow.getAllWindows(),
};

type Services =
  | DesktopEnvironment.DesktopEnvironment
  | DesktopAssets.DesktopAssets
  | DesktopState.DesktopState
  | ElectronApp.ElectronApp
  | ElectronWindow.ElectronWindow
  | DesktopWindow.DesktopWindow;

export class DesktopTray extends Context.Service<
  DesktopTray,
  { readonly configure: Effect.Effect<void, never, Scope.Scope | Services> }
>()("@t3tools/desktop/window/DesktopTray") {}

const { logWarning } = makeComponentLogger("desktop-tray");

/** @public */
export const make = (factory: TrayFactory = electronFactory) =>
  DesktopTray.of({
    configure: Effect.gen(function* () {
      const environment = yield* DesktopEnvironment.DesktopEnvironment;
      if (environment.platform !== "win32") return;
      const assets = yield* DesktopAssets.DesktopAssets;
      const state = yield* DesktopState.DesktopState;
      const electronApp = yield* ElectronApp.ElectronApp;
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      const desktopWindow = yield* DesktopWindow.DesktopWindow;
      const context = yield* Effect.context<Services>();
      const runPromise = Effect.runPromiseWith(context);
      const runSync = Effect.runSyncWith(context);
      const safely = <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(Effect.catchCause((cause) => logWarning("tray callback failed", { cause })));
      const activate = () => runPromise(safely(desktopWindow.activate));
      const quit = () => runPromise(safely(electronApp.quit));
      let quitRequested = false;
      let trayReady = false;
      const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
        Scope.close(scope, Exit.void),
      );

      yield* Effect.gen(function* () {
        const { ico } = yield* assets.iconPaths;
        if (Option.isNone(ico)) {
          yield* logWarning("Windows tray icon is unavailable");
          return;
        }
        const destroy = Effect.fn("desktop.tray.destroy")(function (
          tray: ReturnType<TrayFactory["create"]>,
        ) {
          return Effect.sync(() => {
            trayReady = false;
            if (!tray.isDestroyed()) tray.destroy();
          }).pipe(Effect.catchCause((cause) => logWarning("failed to destroy tray", { cause })));
        });
        const tray = yield* Effect.acquireRelease(
          Effect.sync(() => factory.create(ico.value)),
          destroy,
        );
        yield* Effect.sync(() => {
          tray.setToolTip(environment.displayName);
          tray.setContextMenu(
            factory.buildMenu([
              { label: `Open ${environment.displayName}`, click: activate },
              { type: "separator" },
              { label: `Quit ${environment.displayName}`, click: quit },
            ]),
          );
          tray.on("click", activate);
          tray.on("double-click", activate);
        });
        yield* electronApp.on("before-quit", () => {
          quitRequested = true;
        });
        yield* electronApp.onBeforeQuitForUpdate(() => {
          quitRequested = true;
          runSync(destroy(tray));
        });

        const attach = Effect.fn("desktop.tray.attach")(function* (window: Electron.BrowserWindow) {
          const isMain = Effect.map(
            electronWindow.main,
            (main) => Option.isSome(main) && main.value === window,
          );
          const close = (event: Electron.Event) =>
            runSync(
              safely(
                Effect.gen(function* () {
                  const action = resolveTrayCloseAction({
                    platform: environment.platform,
                    trayReady,
                    isMainWindow: yield* isMain,
                    quitRequested,
                    quitting: yield* Ref.get(state.quitting),
                  });
                  if (action === "hide") {
                    event.preventDefault();
                    window.hide();
                  }
                }),
              ),
            );
          const sessionEnd = () => {
            runSync(
              safely(
                Effect.gen(function* () {
                  if (!(yield* isMain)) return;
                  quitRequested = true;
                  yield* electronApp.quit;
                }),
              ),
            );
          };
          yield* Effect.addFinalizer(() =>
            safely(
              Effect.sync(() => {
                window.removeListener("close", close);
                window.removeListener("session-end", sessionEnd);
              }),
            ),
          );
          yield* Effect.sync(() => {
            window.on("close", close);
            window.on("session-end", sessionEnd);
          });
        });
        yield* electronApp.on(
          "browser-window-created",
          (_event: Electron.Event, window: Electron.BrowserWindow) => {
            runSync(safely(Scope.provide(scope)(attach(window))));
          },
        );
        const windows = yield* Effect.sync(factory.windows);
        for (const window of windows) yield* attach(window);
        trayReady = true;
      }).pipe(
        Scope.provide(scope),
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* logWarning("Windows tray setup failed", { cause });
            yield* Scope.close(scope, Exit.void);
          }),
        ),
      );
    }).pipe(Effect.withSpan("desktop.tray.configure")),
  });

export const layer = Layer.sync(DesktopTray, make);
