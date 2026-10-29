const { desktopCapturer, screen, nativeImage } = require('electron');
const { execSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const logger = require('../core/logger').createServiceLogger('CAPTURE');

class CaptureService {
  constructor() {
    this.isProcessing = false;
    this._nativeToolChecked = false;
    this._nativeTool = null; // 'gnome-screenshot' | 'grim' | 'scrot' | 'import' | null
  }

  /**
   * Detect which native screenshot tool is available on Linux.
   * Results are cached after first check.
   */
  _detectNativeTool() {
    if (this._nativeToolChecked) return this._nativeTool;
    this._nativeToolChecked = true;

    if (process.platform !== 'linux') return null;

    const tools = ['opencluely-python', 'gnome-screenshot', 'grim', 'scrot', 'import', 'spectacle'];
    for (const tool of tools) {
      if (tool === 'opencluely-python') {
        const scriptPath = path.join(__dirname, '../../scripts/screenshot_helper.py');
        if (fs.existsSync(scriptPath)) {
          this._nativeTool = tool;
          logger.info('Native screenshot tool detected', { tool });
          return tool;
        }
        continue;
      }
      try {
        execSync(`which ${tool}`, { stdio: 'ignore' });
        this._nativeTool = tool;
        logger.info('Native screenshot tool detected', { tool });
        return tool;
      } catch (_) {
        // tool not found, try next
      }
    }

    logger.warn('No native screenshot tool found, will use desktopCapturer (may show permission dialog on Wayland)');
    return null;
  }

  /**
   * Take a screenshot using a native Linux CLI tool.
   * Returns a PNG buffer or null if it fails.
   */
  _captureWithNativeTool() {
    const tool = this._detectNativeTool();
    if (!tool) return null;

    const tmpFile = path.join(os.tmpdir(), `opencluely_screenshot_${Date.now()}.png`);

    try {
      switch (tool) {
        case 'opencluely-python': {
          const scriptPath = path.join(__dirname, '../../scripts/screenshot_helper.py');
          execFileSync('python3', [scriptPath, tmpFile], {
            timeout: 10000,
            stdio: 'ignore'
          });
          break;
        }
        case 'gnome-screenshot':
          execFileSync('gnome-screenshot', ['-f', tmpFile], {
            timeout: 10000,
            stdio: 'ignore'
          });
          break;
        case 'grim':
          execFileSync('grim', [tmpFile], {
            timeout: 10000,
            stdio: 'ignore'
          });
          break;
        case 'scrot':
          execFileSync('scrot', [tmpFile], {
            timeout: 10000,
            stdio: 'ignore'
          });
          break;
        case 'import':
          execFileSync('import', ['-window', 'root', tmpFile], {
            timeout: 10000,
            stdio: 'ignore'
          });
          break;
        case 'spectacle':
          execFileSync('spectacle', ['-b', '-n', '-o', tmpFile], {
            timeout: 10000,
            stdio: 'ignore'
          });
          break;
        default:
          return null;
      }

      if (fs.existsSync(tmpFile)) {
        const buffer = fs.readFileSync(tmpFile);
        // Clean up temp file
        try { fs.unlinkSync(tmpFile); } catch (_) {}
        logger.info('Native screenshot captured successfully', { tool, bytes: buffer.length });
        return buffer;
      }
    } catch (err) {
      logger.warn('Native screenshot tool failed', { tool, error: err.message });
      // Clean up temp file on failure
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    }

    return null;
  }

  listDisplays() {
    try {
      const displays = screen.getAllDisplays().map(d => ({
        id: d.id,
        bounds: d.bounds,
        size: d.size,
        scaleFactor: d.scaleFactor,
        rotation: d.rotation,
        touchSupport: d.touchSupport || 'unknown'
      }));
      return { success: true, displays };
    } catch (error) {
      logger.error('Failed to list displays', { error: error.message });
      return { success: false, error: error.message };
    }
  }

  /**
   * Capture screenshot and return an image buffer.
   * options: { displayId?: number, area?: { x, y, width, height } }
   */
  async captureAndProcess(options = {}) {
    if (this.isProcessing) throw new Error('Capture already in progress');
    this.isProcessing = true;
    const startTime = Date.now();
    try {
      // On Linux, try native screenshot tool first to avoid Wayland permission dialog
      if (process.platform === 'linux') {
        const nativeBuffer = this._captureWithNativeTool();
        if (nativeBuffer) {
          let finalImage = nativeImage.createFromBuffer(nativeBuffer);

          // Crop if area specified
          if (options.area && this._isValidArea(options.area)) {
            try {
              finalImage = finalImage.crop(options.area);
            } catch (e) {
              logger.warn('Crop failed, returning full image', { error: e.message, area: options.area });
            }
          }

          const buffer = finalImage.toPNG();
          logger.logPerformance('Screenshot capture (native)', startTime, {
            bytes: buffer.length,
            dimensions: finalImage.getSize()
          });

          return {
            imageBuffer: buffer,
            mimeType: 'image/png',
            metadata: {
              timestamp: new Date().toISOString(),
              source: { method: 'native-linux', tool: this._nativeTool },
              processingTime: Date.now() - startTime
            }
          };
        }
      }

      // Fallback: use Electron's desktopCapturer (works on macOS/Windows, 
      // but may show permission dialog on Linux Wayland)
      const { image, metadata } = await this.captureScreenshot(options);

      // Crop if area specified
      let finalImage = image;
      if (options.area && this._isValidArea(options.area)) {
        try {
          finalImage = image.crop(options.area);
        } catch (e) {
          logger.warn('Crop failed, returning full image', { error: e.message, area: options.area });
        }
      }

      const buffer = finalImage.toPNG();
      logger.logPerformance('Screenshot capture', startTime, {
        bytes: buffer.length,
        dimensions: finalImage.getSize()
      });

      return {
        imageBuffer: buffer,
        mimeType: 'image/png',
        metadata: {
          timestamp: new Date().toISOString(),
          source: metadata,
          processingTime: Date.now() - startTime
        }
      };
    } finally {
      this.isProcessing = false;
    }
  }

  async captureScreenshot(options = {}) {
    const targetDisplay = this._getTargetDisplay(options.displayId);
    const { width, height } = targetDisplay.size || { width: 1920, height: 1080 };

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height }
    });

    if (sources.length === 0) {
      throw new Error('No screen sources available for capture');
    }

    // Find source matching the target display by comparing sizes as heuristic
    let source = sources[0];
    const match = sources.find(s => {
      const size = s.thumbnail.getSize();
      return size.width === width && size.height === height;
    });
    if (match) source = match;

    const image = source.thumbnail;
    if (!image) throw new Error('Failed to capture screen thumbnail');

    logger.debug('Screenshot captured successfully', {
      sourceName: source.name,
      imageSize: image.getSize()
    });

    return {
      image,
      metadata: {
        displayId: targetDisplay.id,
        sourceName: source.name,
        dimensions: image.getSize(),
        captureTime: new Date().toISOString()
      }
    };
  }

  _getTargetDisplay(displayId) {
    const all = screen.getAllDisplays();
    if (!all || all.length === 0) return screen.getPrimaryDisplay();
    if (displayId == null) return screen.getPrimaryDisplay();
    const found = all.find(d => d.id === displayId);
    return found || screen.getPrimaryDisplay();
  }

  _isValidArea(area) {
    return area && Number.isFinite(area.x) && Number.isFinite(area.y) &&
      Number.isFinite(area.width) && Number.isFinite(area.height) &&
      area.width > 0 && area.height > 0;
  }
}

module.exports = new CaptureService();
