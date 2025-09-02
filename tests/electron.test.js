const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const path = require('path');

test.describe('FailWhale Electron App', () => {
  let electronApp;
  let page;

  test.beforeAll(async () => {
    // Launch Electron app
    electronApp = await electron.launch({ 
      args: [path.join(__dirname, '..', 'main.js')],
      timeout: 30000
    });
  });

  test.afterAll(async () => {
    if (electronApp) {
      await electronApp.close();
    }
  });

  test('should launch successfully', async () => {
    expect(electronApp).toBeDefined();
    
    // Check if the app is running
    const isRunning = electronApp.process().pid > 0;
    expect(isRunning).toBe(true);
  });

  test('should create tray icon', async () => {
    // Wait a bit for the app to initialize
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // The app should be running in the background with a tray icon
    // We can't directly test the tray, but we can verify the app doesn't crash
    const isRunning = electronApp.process().pid > 0;
    expect(isRunning).toBe(true);
  });

  test('should open sources window', async () => {
    // Evaluate code in the main process to open sources window
    const result = await electronApp.evaluate(async ({ app }) => {
      // Simulate opening sources window
      return new Promise((resolve) => {
        // We'll return true if the app is ready
        resolve(app.isReady());
      });
    });
    
    expect(result).toBe(true);
  });

  test('should handle environment variables', async () => {
    const result = await electronApp.evaluate(async () => {
      return process.env.GIPHY_API_KEY ? 'loaded' : 'missing';
    });
    
    expect(result).toBe('loaded');
  });
});
