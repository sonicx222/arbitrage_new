/**
 * V8 Profiler Utility (Task #46)
 *
 * Wrapper for V8 CPU profiling with flame graph generation.
 * Captures performance profiles during hot-path execution.
 *
 * @example
 * const profiler = new V8Profiler();
 * await profiler.startProfiling('cache-write-hotpath');
 * // ... execute hot-path code ...
 * const profile = await profiler.stopProfiling();
 * await profiler.generateFlameGraph(profile, 'output/flamegraph.svg');
 */

import { join } from 'path';
import { mkdir, writeFile } from 'fs/promises';
import { createLogger } from '../logger';

const logger = createLogger('v8-profiler');

export interface ProfileResult {
  title: string;
  samples: number;
  duration: number;
  profile: any; // v8-profiler-next profile object
}

export interface ProfileOptions {
  sampleInterval?: number; // Microseconds (default: 1000μs = 1ms)
  outputDir?: string; // Output directory for profiles
}

export class V8Profiler {
  private profiler: any = null;
  private outputDir: string;
  private sampleInterval: number;
  private outputDirReady = false;
  // BUG-011 FIX: Track whether loading has been attempted (lazy init)
  private loadAttempted = false;

  constructor(options: ProfileOptions = {}) {
    this.outputDir = options.outputDir || join(process.cwd(), '.profiler-output');
    this.sampleInterval = options.sampleInterval || 1000; // 1ms default
  }

  /**
   * BUG-011 FIX: Lazy-load v8-profiler-next using dynamic import() instead of require().
   * Compatible with ESM migration. Called automatically before profiling operations.
   */
  private async ensureProfiler(): Promise<boolean> {
    if (this.loadAttempted) return this.profiler !== null;
    this.loadAttempted = true;
    try {
      // Use variable to prevent TypeScript from statically resolving the optional module
      const moduleName = 'v8-profiler-next';
      const mod = await import(/* webpackIgnore: true */ moduleName);
      this.profiler = mod.default ?? mod;
      this.profiler.setSamplingInterval(this.sampleInterval);
      return true;
    } catch {
      logger.warn('v8-profiler-next not available. Install with: npm install --save-dev v8-profiler-next');
      return false;
    }
  }

  /**
   * Ensure the output directory exists (lazy init, called before file writes).
   */
  private async ensureOutputDir(): Promise<void> {
    if (this.outputDirReady) return;
    await mkdir(this.outputDir, { recursive: true });
    this.outputDirReady = true;
  }

  /**
   * Check if profiler is available.
   * Note: Returns false until ensureProfiler() has been called (lazy init).
   * Use isAvailableAsync() for a definitive check.
   */
  isAvailable(): boolean {
    return this.profiler !== null;
  }

  /**
   * BUG-011 FIX: Async availability check that triggers lazy loading.
   */
  async isAvailableAsync(): Promise<boolean> {
    return this.ensureProfiler();
  }

  /**
   * Start CPU profiling
   */
  async startProfiling(title: string = 'profile'): Promise<void> {
    // BUG-011 FIX: Trigger lazy load via dynamic import()
    await this.ensureProfiler();
    if (!this.profiler) {
      throw new Error('V8 profiler not available. Install v8-profiler-next.');
    }

    this.profiler.startProfiling(title, true);
    logger.info(`Started profiling: ${title} (sampling interval: ${this.sampleInterval}us)`);
  }

  /**
   * Stop CPU profiling and return profile
   */
  async stopProfiling(title?: string): Promise<ProfileResult> {
    if (!this.profiler) {
      throw new Error('V8 profiler not available.');
    }

    const profile = this.profiler.stopProfiling(title);

    // Calculate duration and samples
    const startTime = profile.startTime;
    const endTime = profile.endTime;
    const duration = endTime - startTime;
    const samples = profile.samples?.length ?? 0;

    logger.info(`Stopped profiling: ${profile.title || 'profile'} (duration: ${duration}us, samples: ${samples})`);

    return {
      title: profile.title || 'profile',
      samples,
      duration,
      profile,
    };
  }

  /**
   * Export profile to JSON (cpuprofile format)
   */
  async exportProfile(profileResult: ProfileResult, filename?: string): Promise<string> {
    if (!filename) {
      filename = `${profileResult.title}-${Date.now()}.cpuprofile`;
    }

    await this.ensureOutputDir();
    const filepath = join(this.outputDir, filename);

    return new Promise((resolve, reject) => {
      profileResult.profile.export(async (error: Error | null, result: string) => {
        if (error) {
          reject(error);
          return;
        }

        try {
          await writeFile(filepath, result, 'utf8');
          profileResult.profile.delete();
          logger.info(`Exported profile: ${filepath}`);
          resolve(filepath);
        } catch (writeError) {
          reject(writeError);
        }
      });
    });
  }

  /**
   * Generate flame graph from profile (requires stackvis or speedscope)
   */
  async generateFlameGraph(profileResult: ProfileResult, outputPath?: string): Promise<string> {
    const cpuprofilePath = await this.exportProfile(profileResult);

    if (!outputPath) {
      outputPath = cpuprofilePath.replace('.cpuprofile', '.flamegraph.html');
    }

    // Generate simple HTML file with instructions to view in speedscope
    const htmlContent = `<!DOCTYPE html>
<html>
<head>
  <title>Profile: ${profileResult.title}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 800px;
      margin: 50px auto;
      padding: 20px;
    }
    .profile-info {
      background: #f5f5f5;
      padding: 20px;
      border-radius: 8px;
      margin-bottom: 20px;
    }
    .button {
      display: inline-block;
      background: #007bff;
      color: white;
      padding: 12px 24px;
      text-decoration: none;
      border-radius: 4px;
      font-weight: 500;
    }
    .button:hover {
      background: #0056b3;
    }
    code {
      background: #e9ecef;
      padding: 2px 6px;
      border-radius: 3px;
    }
  </style>
</head>
<body>
  <h1>CPU Profile: ${profileResult.title}</h1>

  <div class="profile-info">
    <p><strong>Duration:</strong> ${(profileResult.duration / 1000).toFixed(2)}ms</p>
    <p><strong>Samples:</strong> ${profileResult.samples}</p>
    <p><strong>Sampling Interval:</strong> ${this.sampleInterval}μs</p>
    <p><strong>Profile File:</strong> <code>${cpuprofilePath}</code></p>
  </div>

  <h2>View in Speedscope</h2>
  <p>To generate an interactive flame graph:</p>
  <ol>
    <li>Install speedscope: <code>npm install -g speedscope</code></li>
    <li>Run: <code>speedscope ${cpuprofilePath}</code></li>
    <li>Or visit <a href="https://www.speedscope.app/" target="_blank">speedscope.app</a> and drag the .cpuprofile file</li>
  </ol>

  <a href="https://www.speedscope.app/" target="_blank" class="button">Open Speedscope Online</a>

  <h2>View in Chrome DevTools</h2>
  <ol>
    <li>Open Chrome DevTools (F12)</li>
    <li>Go to "Performance" tab</li>
    <li>Click "Load profile" icon</li>
    <li>Select: <code>${cpuprofilePath}</code></li>
  </ol>
</body>
</html>`;

    await this.ensureOutputDir();
    await writeFile(outputPath, htmlContent, 'utf8');
    logger.info(`Generated flame graph HTML: ${outputPath}`);
    logger.info(`View profile: open ${cpuprofilePath} in Chrome DevTools or Speedscope`);

    return outputPath;
  }

  /**
   * Profile a function execution
   */
  async profile<T>(
    name: string,
    fn: () => Promise<T> | T,
    options: { exportProfile?: boolean; generateFlameGraph?: boolean } = {}
  ): Promise<{ result: T; profileResult: ProfileResult }> {
    await this.startProfiling(name);

    const result = await fn();

    const profileResult = await this.stopProfiling(name);

    if (options.exportProfile !== false) {
      await this.exportProfile(profileResult);
    }

    if (options.generateFlameGraph) {
      await this.generateFlameGraph(profileResult);
    }

    return { result, profileResult };
  }

  /**
   * Get output directory
   */
  getOutputDir(): string {
    return this.outputDir;
  }

  /**
   * Clean up old profile files
   */
  async cleanup(olderThanMs: number = 24 * 60 * 60 * 1000): Promise<void> {
    // Implementation would clean up old .cpuprofile files
    logger.info(`Cleanup: would remove profiles older than ${olderThanMs}ms`);
  }
}

/**
 * Global profiler instance
 */
let globalProfiler: V8Profiler | null = null;

export function getGlobalProfiler(): V8Profiler {
  if (!globalProfiler) {
    globalProfiler = new V8Profiler();
  }
  return globalProfiler;
}

/**
 * Convenience function to profile code
 */
export async function profileHotPath<T>(
  name: string,
  fn: () => Promise<T> | T
): Promise<{ result: T; profileResult: ProfileResult | null }> {
  const profiler = getGlobalProfiler();

  // BUG-011 FIX: Use async check to trigger lazy loading via import()
  if (!(await profiler.isAvailableAsync())) {
    logger.warn('V8 profiler not available, running without profiling');
    const result = await fn();
    return { result, profileResult: null };
  }

  return profiler.profile(name, fn, { exportProfile: true, generateFlameGraph: true });
}
