import { Menu, Tray, nativeImage } from 'electron';
import { displayAccelerator } from '@shared/accelerator';
import type { Settings } from '@shared/types';

export interface TrayActions {
  readonly openHistory: () => void;
  readonly openScreenshots: () => void;
  readonly openStats: () => void;
  readonly openSettings: () => void;
  readonly compare: () => void;
  readonly setCaptureEnabled: (enabled: boolean) => void;
  readonly setLaunchAtLogin: (enabled: boolean) => void;
  readonly quit: () => void;
}

/** The tray is the app's home: Clipboard & Screenshot Archive has no taskbar presence. */
export class AppTray {
  private readonly tray: Tray;

  constructor(
    iconPath: string,
    /** Whether the OS supports login items; the menu item is hidden otherwise. */
    private readonly launchAtLoginSupported: boolean,
    private readonly actions: TrayActions,
  ) {
    const icon = nativeImage.createFromPath(iconPath);
    if (process.platform === 'darwin') icon.setTemplateImage(true);
    this.tray = new Tray(icon);
    this.tray.setToolTip('Clipboard & Screenshot Archive');
    this.tray.on('click', actions.openHistory);
  }

  update(settings: Settings): void {
    const { actions } = this;
    const key = (accelerator: string): string => displayAccelerator(accelerator, process.platform);
    this.tray.setToolTip(
      settings.captureEnabled
        ? 'Clipboard & Screenshot Archive'
        : 'Clipboard & Screenshot Archive (paused)',
    );
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: `Open history\t${key(settings.shortcuts.openHistory)}`,
          click: actions.openHistory,
        },
        { label: 'Screenshots', click: actions.openScreenshots },
        { label: `Compare clipboard\t${key(settings.shortcuts.compare)}`, click: actions.compare },
        { label: 'Statistics', click: actions.openStats },
        { type: 'separator' },
        {
          label: 'Pause capture',
          type: 'checkbox',
          checked: !settings.captureEnabled,
          click: (item) => actions.setCaptureEnabled(!item.checked),
        },
        {
          label: 'Launch at login',
          type: 'checkbox',
          visible: this.launchAtLoginSupported,
          checked: settings.launchAtLogin,
          click: (item) => actions.setLaunchAtLogin(item.checked),
        },
        { label: 'Settings…', click: actions.openSettings },
        { type: 'separator' },
        { label: 'Quit Clipboard & Screenshot Archive', click: actions.quit },
      ]),
    );
  }

  destroy(): void {
    this.tray.destroy();
  }
}
