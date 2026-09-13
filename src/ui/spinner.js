/**
 * Non-blocking Live Terminal Spinner & Status Indicator
 * Designed for Termux CLI without third-party dependencies.
 */

import { ansi } from '../utils/ansi.js';

const DEFAULT_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const DEFAULT_INTERVAL = 80;

export class Spinner {
  /**
   * @param {object} [options={}]
   * @param {string} [options.text=''] - Initial status text
   * @param {string[]} [options.frames] - Custom spinner frames
   * @param {number} [options.interval=80] - Animation frame interval (ms)
   * @param {NodeJS.WriteStream} [options.stream=process.stdout] - Output stream
   * @param {boolean} [options.enabled] - Force enable/disable
   */
  constructor(options = {}) {
    this.text = options.text || '';
    this.frames = options.frames || DEFAULT_FRAMES;
    this.interval = options.interval || DEFAULT_INTERVAL;
    this.stream = options.stream || process.stdout;
    this.enabled =
      options.enabled !== undefined ? Boolean(options.enabled) : Boolean(this.stream?.isTTY);
    this.showTimer = options.showTimer !== false;
    this.showDurationOnFinish = Boolean(options.showDurationOnFinish);

    this.frameIndex = 0;
    this.timer = null;
    this.spinning = false;
    this.startTime = null;
    this.totalStartTime = null;
    this.lastElapsed = 0;
  }

  /**
   * Formats duration in ms to human-readable string (e.g. '0.2s', '5.4s', '1m 23s')
   * @param {number} ms
   * @returns {string}
   */
  formatDuration(ms) {
    if (!ms || ms <= 0) return '0.0s';
    const totalSec = ms / 1000;
    if (totalSec < 60) {
      return `${totalSec.toFixed(1)}s`;
    }
    const mins = Math.floor(totalSec / 60);
    const secs = Math.floor(totalSec % 60);
    return `${mins}m ${secs}s`;
  }

  /**
   * Returns elapsed time in milliseconds for the current stage
   * @returns {number}
   */
  getElapsed() {
    return this.startTime ? Date.now() - this.startTime : 0;
  }

  /**
   * Returns total elapsed time in milliseconds since spinner was first started
   * @returns {number}
   */
  getTotalElapsed() {
    return this.totalStartTime ? Date.now() - this.totalStartTime : 0;
  }

  /**
   * Starts or resumes spinner animation
   * @param {string} [text]
   * @param {object} [options={}]
   * @param {boolean} [options.resetTimer=true] - Reset stage stopwatch on new text
   * @returns {Spinner}
   */
  start(text, options = {}) {
    const isNewText = text !== undefined && text !== this.text;
    if (text !== undefined) {
      this.text = text;
    }

    const now = Date.now();
    if (!this.spinning) {
      this.totalStartTime = now;
      this.startTime = now;
    } else if (isNewText && options.resetTimer !== false) {
      this.startTime = now;
    }

    if (this.spinning) {
      this.render();
      return this;
    }

    this.spinning = true;
    this.frameIndex = 0;

    if (!this.enabled) {
      if (this.text) {
        this.stream.write(`ℹ ${this.text}\n`);
      }
      return this;
    }

    // Hide cursor if supported
    if (this.stream.isTTY) {
      this.stream.write('\x1b[?25l');
    }

    this.render();

    this.timer = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % this.frames.length;
      this.render();
    }, this.interval);

    // Ensure timer doesn't hold event loop open if unref is available
    if (this.timer && typeof this.timer.unref === 'function') {
      this.timer.unref();
    }

    return this;
  }

  /**
   * Renders the current frame to the terminal with optional live stopwatch
   */
  render() {
    if (!this.enabled || !this.spinning) return;
    const frame = ansi.cyan(this.frames[this.frameIndex]);
    const timerStr =
      this.showTimer && this.startTime
        ? ` ${ansi.dim(`(${this.formatDuration(this.getElapsed())})`)}`
        : '';
    this.stream.write(`\r\x1b[K${frame} ${this.text}${timerStr}`);
  }

  /**
   * Updates spinner text without resetting stage timer
   * @param {string} text
   * @returns {Spinner}
   */
  update(text) {
    this.text = text || '';
    if (this.spinning && this.enabled) {
      this.render();
    }
    return this;
  }

  /**
   * Stops the spinner animation and clears the line
   * @returns {Spinner}
   */
  stop() {
    if (!this.spinning) return this;

    this.lastElapsed = this.getElapsed();

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.spinning = false;

    if (this.enabled) {
      this.stream.write('\r\x1b[K');
      if (this.stream.isTTY) {
        this.stream.write('\x1b[?25h'); // Show cursor
      }
    }

    return this;
  }

  /**
   * Stops spinner and prints a success mark
   * @param {string} [text]
   * @returns {Spinner}
   */
  succeed(text) {
    const msg = text !== undefined ? text : this.text;
    const durationSuffix =
      this.showDurationOnFinish && this.startTime
        ? ` ${ansi.dim(`(${this.formatDuration(this.getElapsed())})`)}`
        : '';
    this.stop();
    const symbol = ansi.green('✔');
    this.stream.write(`${symbol} ${msg}${durationSuffix}\n`);
    return this;
  }

  /**
   * Stops spinner and prints a failure mark
   * @param {string} [text]
   * @returns {Spinner}
   */
  fail(text) {
    const msg = text !== undefined ? text : this.text;
    const durationSuffix =
      this.showDurationOnFinish && this.startTime
        ? ` ${ansi.dim(`(${this.formatDuration(this.getElapsed())})`)}`
        : '';
    this.stop();
    const symbol = ansi.red('✖');
    this.stream.write(`${symbol} ${msg}${durationSuffix}\n`);
    return this;
  }

  /**
   * Stops spinner and prints a warning mark
   * @param {string} [text]
   * @returns {Spinner}
   */
  warn(text) {
    const msg = text !== undefined ? text : this.text;
    const durationSuffix =
      this.showDurationOnFinish && this.startTime
        ? ` ${ansi.dim(`(${this.formatDuration(this.getElapsed())})`)}`
        : '';
    this.stop();
    const symbol = ansi.yellow('⚠');
    this.stream.write(`${symbol} ${msg}${durationSuffix}\n`);
    return this;
  }

  /**
   * Stops spinner and prints an info mark
   * @param {string} [text]
   * @returns {Spinner}
   */
  info(text) {
    const msg = text !== undefined ? text : this.text;
    const durationSuffix =
      this.showDurationOnFinish && this.startTime
        ? ` ${ansi.dim(`(${this.formatDuration(this.getElapsed())})`)}`
        : '';
    this.stop();
    const symbol = ansi.cyan('ℹ');
    this.stream.write(`${symbol} ${msg}${durationSuffix}\n`);
    return this;
  }

  /**
   * Returns current spinning status
   * @returns {boolean}
   */
  isSpinning() {
    return this.spinning;
  }
}

/**
 * Factory to create a Spinner instance
 * @param {string|object} [options]
 * @returns {Spinner}
 */
export function createSpinner(options) {
  if (typeof options === 'string') {
    return new Spinner({ text: options });
  }
  return new Spinner(options);
}
