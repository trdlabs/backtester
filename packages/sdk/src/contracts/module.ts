export type BacktestEngine = 'momentum' | 'overlay';

export type ModuleKind = 'strategy' | 'overlay';

export interface ModuleManifest {
  readonly id: string;
  readonly version: string;
  readonly kind: ModuleKind;
  readonly bundleContractVersion: string;
}

export interface ModuleBundle {
  readonly manifest: ModuleManifest;
  readonly entry: string;
  readonly files: Readonly<Record<string, string>>;
}
