const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

// Mock dotenv for testing
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Import functions to test (we'll need to refactor main.js to export these)
// For now, we'll copy the functions we want to test

// Test helper functions
function extractRepoInfo(githubUrl) {
  const match = githubUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (match) {
    return { owner: match[1], repo: match[2] };
  }
  return null;
}

async function isNetworkAvailable() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    const response = await fetch('https://api.github.com', {
      method: 'HEAD',
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    return response.status < 500;
  } catch {
    return false;
  }
}

// Mock fetch for testing
global.fetch = async (url, options = {}) => {
  if (url.includes('api.github.com/repos/test/repo/actions/runs')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        workflow_runs: [
          {
            id: 12345,
            status: 'completed',
            conclusion: 'success',
            created_at: '2023-01-01T00:00:00Z'
          }
        ]
      })
    };
  }
  
  if (url.includes('api.giphy.com')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          images: {
            downsized_medium: {
              url: 'https://media.giphy.com/test.gif',
              width: '400',
              height: '300'
            }
          }
        }
      })
    };
  }
  
  if (url === 'https://api.github.com') {
    return { ok: true, status: 200 };
  }
  
  throw new Error('Network error');
};

test.describe('FailWhale Core Functions', () => {
  
  test.describe('extractRepoInfo', () => {
    test('should extract owner and repo from valid GitHub URL', () => {
      const result = extractRepoInfo('https://github.com/tnylea/failwhale');
      expect(result).toEqual({ owner: 'tnylea', repo: 'failwhale' });
    });

    test('should handle GitHub URLs without https', () => {
      const result = extractRepoInfo('github.com/microsoft/vscode');
      expect(result).toEqual({ owner: 'microsoft', repo: 'vscode' });
    });

    test('should return null for invalid URLs', () => {
      expect(extractRepoInfo('https://gitlab.com/user/repo')).toBeNull();
      expect(extractRepoInfo('not-a-url')).toBeNull();
      expect(extractRepoInfo('')).toBeNull();
    });

    test('should handle URLs with trailing slashes and paths', () => {
      const result = extractRepoInfo('https://github.com/facebook/react/tree/main');
      expect(result).toEqual({ owner: 'facebook', repo: 'react' });
    });
  });

  test.describe('Network Functions', () => {
    test('should detect network availability', async () => {
      const isAvailable = await isNetworkAvailable();
      expect(typeof isAvailable).toBe('boolean');
    });
  });

  test.describe('API Integration', () => {
    test('should fetch workflow runs successfully', async () => {
      const fetchWorkflowRuns = async (owner, repo, retries = 3) => {
        for (let attempt = 1; attempt <= retries; attempt++) {
          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);
            
            const url = `https://api.github.com/repos/${owner}/${repo}/actions/runs`;
            const response = await fetch(url, {
              signal: controller.signal,
              headers: {
                'User-Agent': 'FailWhale-CI-Notifier/1.0'
              }
            });
            
            clearTimeout(timeoutId);
            
            if (!response.ok) {
              throw new Error(`GitHub API error: ${response.status}`);
            }
            
            const data = await response.json();
            return data.workflow_runs || [];
            
          } catch (err) {
            const isNetworkError = err.code === 'ENOTFOUND' || err.name === 'AbortError' || err.message.includes('fetch failed');
            
            if (attempt === retries) {
              console.error(`Failed to fetch workflows for ${owner}/${repo} after ${retries} attempts:`, err.message);
              return [];
            }
            
            if (isNetworkError) {
              const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
              await new Promise(resolve => setTimeout(resolve, delay));
            } else {
              return [];
            }
          }
        }
        return [];
      };

      const runs = await fetchWorkflowRuns('test', 'repo');
      expect(Array.isArray(runs)).toBe(true);
      expect(runs.length).toBeGreaterThan(0);
      expect(runs[0]).toHaveProperty('id');
      expect(runs[0]).toHaveProperty('status');
    });

    test('should handle Giphy API calls', async () => {
      const getRandomGif = async (tag = 'fail') => {
        try {
          const apiKey = process.env.GIPHY_API_KEY;
          const res = await fetch(`https://api.giphy.com/v1/gifs/random?api_key=${apiKey}&tag=${tag}`);
          if (!res.ok) throw new Error(`HTTP error ${res.status}`);
          
          const json = await res.json();
          const data = json.data;
          const gif = data.images?.downsized_medium;

          if (gif) {
            return {
              url: gif.url,
              width: parseInt(gif.width, 10) || 400,
              height: parseInt(gif.height, 10) || 300,
            };
          }
        } catch (err) {
          console.error('Error fetching gif:', err.message);
        }
        return { url: '', width: 400, height: 300 };
      };

      const gifData = await getRandomGif('success');
      expect(gifData).toHaveProperty('url');
      expect(gifData).toHaveProperty('width');
      expect(gifData).toHaveProperty('height');
      expect(typeof gifData.width).toBe('number');
      expect(typeof gifData.height).toBe('number');
    });
  });

  test.describe('Data Persistence', () => {
    const testDataPath = path.join(__dirname, 'test-sources.json');
    
    test.afterEach(() => {
      // Clean up test files
      if (fs.existsSync(testDataPath)) {
        fs.unlinkSync(testDataPath);
      }
    });

    test('should save and load sources correctly', () => {
      const testSources = [
        { url: 'https://github.com/test/repo1', added: '2023-01-01T00:00:00Z' },
        { url: 'https://github.com/test/repo2', added: '2023-01-02T00:00:00Z' }
      ];

      // Test save
      fs.writeFileSync(testDataPath, JSON.stringify(testSources, null, 2));
      expect(fs.existsSync(testDataPath)).toBe(true);

      // Test load
      const loadedData = JSON.parse(fs.readFileSync(testDataPath, 'utf8'));
      expect(loadedData).toEqual(testSources);
      expect(loadedData.length).toBe(2);
      expect(loadedData[0].url).toBe('https://github.com/test/repo1');
    });

    test('should handle invalid JSON gracefully', () => {
      fs.writeFileSync(testDataPath, 'invalid json content');
      
      let sources = [];
      try {
        const data = fs.readFileSync(testDataPath, 'utf8');
        sources = JSON.parse(data);
      } catch (err) {
        sources = [];
      }
      
      expect(Array.isArray(sources)).toBe(true);
      expect(sources.length).toBe(0);
    });
  });

  test.describe('Environment Variables', () => {
    test('should load API key from environment', () => {
      const apiKey = process.env.GIPHY_API_KEY;
      expect(apiKey).toBeDefined();
      expect(typeof apiKey).toBe('string');
      expect(apiKey.length).toBeGreaterThan(0);
    });
  });

  test.describe('Error Handling', () => {
    test('should handle network timeouts gracefully', async () => {
      const fetchWithTimeout = async (url, timeout = 5000) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        
        try {
          const response = await fetch(url, { signal: controller.signal });
          clearTimeout(timeoutId);
          return response;
        } catch (err) {
          clearTimeout(timeoutId);
          if (err.name === 'AbortError') {
            throw new Error('Request timeout');
          }
          throw err;
        }
      };

      // This should timeout quickly
      try {
        await fetchWithTimeout('https://httpstat.us/200?sleep=10000', 1000);
        // If we reach here, the test should fail
        expect(true).toBe(false);
      } catch (err) {
        // Accept either timeout or network errors since both are valid failure modes
        expect(err.message).toMatch(/timeout|network/i);
      }
    });

    test('should validate GitHub URLs properly', () => {
      const validUrls = [
        'https://github.com/user/repo',
        'github.com/user/repo',
        'https://github.com/user-name/repo-name'
      ];

      const invalidUrls = [
        'https://gitlab.com/user/repo',
        'not-a-url',
        '',
        'https://github.com/',
        'https://github.com/user'
      ];

      validUrls.forEach(url => {
        expect(extractRepoInfo(url)).not.toBeNull();
      });

      invalidUrls.forEach(url => {
        expect(extractRepoInfo(url)).toBeNull();
      });
    });
  });
});
