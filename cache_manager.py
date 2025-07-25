import json
import os
import time
from datetime import datetime, timedelta
from pathlib import Path

class StravaCache:
    """File-based cache for Strava API data with TTL support"""
    
    def __init__(self, cache_dir="cache"):
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(exist_ok=True)
        
        # Cache TTL settings (in seconds)
        self.ttl_settings = {
            'segment': 24 * 60 * 60,      # 24 hours - segments rarely change
            'activity': 7 * 24 * 60 * 60,  # 7 days - activities don't change
            'streams': 7 * 24 * 60 * 60,   # 7 days - heart rate data doesn't change
            'efforts': 60 * 60             # 1 hour - efforts can have new ones added
        }
    
    def _get_cache_path(self, cache_type, key):
        """Get the file path for a cache entry"""
        filename = f"{cache_type}_{key}.json"
        return self.cache_dir / filename
    
    def _is_expired(self, cache_data, cache_type):
        """Check if cache entry has expired"""
        if 'timestamp' not in cache_data:
            return True
        
        ttl = self.ttl_settings.get(cache_type, 3600)  # Default 1 hour
        age = time.time() - cache_data['timestamp']
        return age > ttl
    
    def get(self, cache_type, key):
        """Get data from cache if exists and not expired"""
        try:
            cache_path = self._get_cache_path(cache_type, key)
            if not cache_path.exists():
                return None
            
            with open(cache_path, 'r') as f:
                cache_data = json.load(f)
            
            if self._is_expired(cache_data, cache_type):
                # Remove expired cache file
                cache_path.unlink()
                return None
            
            return cache_data['data']
        
        except (json.JSONDecodeError, KeyError, OSError):
            # If any error reading cache, treat as cache miss
            return None
    
    def set(self, cache_type, key, data):
        """Store data in cache with timestamp"""
        try:
            cache_path = self._get_cache_path(cache_type, key)
            cache_data = {
                'timestamp': time.time(),
                'data': data
            }
            
            with open(cache_path, 'w') as f:
                json.dump(cache_data, f, indent=2)
        
        except OSError:
            # If we can't write to cache, just continue without caching
            pass
    
    def delete(self, cache_type, key):
        """Delete a cache entry"""
        try:
            cache_path = self._get_cache_path(cache_type, key)
            if cache_path.exists():
                cache_path.unlink()
        except OSError:
            pass
    
    def clear_expired(self):
        """Clear all expired cache entries"""
        try:
            for cache_file in self.cache_dir.glob("*.json"):
                try:
                    with open(cache_file, 'r') as f:
                        cache_data = json.load(f)
                    
                    # Extract cache type from filename
                    cache_type = cache_file.stem.split('_')[0]
                    
                    if self._is_expired(cache_data, cache_type):
                        cache_file.unlink()
                
                except (json.JSONDecodeError, KeyError, OSError):
                    # If we can't read the file, delete it
                    cache_file.unlink()
        
        except OSError:
            pass
    
    def get_cache_stats(self):
        """Get cache statistics"""
        stats = {
            'total_files': 0,
            'by_type': {},
            'total_size': 0
        }
        
        try:
            for cache_file in self.cache_dir.glob("*.json"):
                stats['total_files'] += 1
                stats['total_size'] += cache_file.stat().st_size
                
                # Extract cache type from filename
                cache_type = cache_file.stem.split('_')[0]
                stats['by_type'][cache_type] = stats['by_type'].get(cache_type, 0) + 1
        
        except OSError:
            pass
        
        return stats

# Global cache instance
cache = StravaCache() 