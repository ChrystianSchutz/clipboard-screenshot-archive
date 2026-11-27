import type { ImageAnalysis } from '@shared/image-analysis';
import type { WorkerBody } from '../workers/worker-host';
import { analysisRequestSchema, limitImageAnalysis } from './analysis-schema';
import type { ImageAnalyzer } from './ports';
import type { AnalysisRequest } from './remote-image-analyzer';

/**
 * What the image-analysis worker runs: requests are validated at entry (`analysisRequestSchema`)
 * and results are trimmed to `ANALYSIS_BUDGET` before they are sent back.
 */
export function analysisWorkerBody(
  analyzer: ImageAnalyzer,
): WorkerBody<AnalysisRequest, ImageAnalysis> {
  return {
    id: analyzer.id,
    payload: analysisRequestSchema,
    run: async ({ image, language }) => limitImageAnalysis(await analyzer.analyze(image, language)),
    dispose: () => analyzer.dispose(),
  };
}
