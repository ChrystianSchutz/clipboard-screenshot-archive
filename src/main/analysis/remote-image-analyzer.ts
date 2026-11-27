import type { AnalysisLanguage, ImageAnalysis } from '@shared/image-analysis';
import { WorkerClient, type WorkerProcess } from '../workers/worker-client';
import { responseParser } from '../workers/worker-protocol';
import { imageAnalysisSchema } from './analysis-schema';
import type { AnalysisImage, ImageAnalyzer } from './ports';

export interface AnalysisRequest {
  readonly image: AnalysisImage;
  readonly language: AnalysisLanguage;
}

/** First analysis includes loading the model; later ones take a fraction of this. */
export const IMAGE_ANALYSIS_TIMEOUT_MS = 120_000;
export const IMAGE_ANALYSIS_IDLE_MS = 60_000;

export interface RemoteImageAnalyzerOptions {
  readonly id: string;
  readonly spawn: () => WorkerProcess<AnalysisRequest>;
  readonly onError?: (error: Error) => void;
  readonly timeoutMs?: number;
  readonly idleMs?: number;
}

/** `ImageAnalyzer` that runs Mirage in the analysis utility process (see analysis-host-entry.ts). */
export class RemoteImageAnalyzer implements ImageAnalyzer {
  readonly id: string;
  private readonly client: WorkerClient<AnalysisRequest, ImageAnalysis>;

  constructor(options: RemoteImageAnalyzerOptions) {
    this.id = options.id;
    this.client = new WorkerClient({
      name: 'Image analysis',
      spawn: options.spawn,
      parse: responseParser(imageAnalysisSchema),
      timeoutMs: options.timeoutMs ?? IMAGE_ANALYSIS_TIMEOUT_MS,
      idleMs: options.idleMs ?? IMAGE_ANALYSIS_IDLE_MS,
      ...(options.onError ? { onError: options.onError } : {}),
    });
  }

  analyze(image: AnalysisImage, language: AnalysisLanguage): Promise<ImageAnalysis> {
    return this.client.run({ image, language });
  }

  dispose(): Promise<void> {
    return this.client.dispose();
  }
}
