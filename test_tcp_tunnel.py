#!/usr/bin/env python3
"""
Quick test of TCP tunnel relay_tcp_tunnel method
"""
import asyncio
import json
import sys

sys.path.insert(0, '/home/siavash/Projects/MasterHttpRelayVPN')

from src.relay.domain_fronter import DomainFronter
from src.core.logging_utils import setup_logging

setup_logging("INFO")

async def test_relay_tcp_tunnel():
    """Test the TCP tunnel relay method"""
    
    # Load config
    with open('config.json') as f:
        config = json.load(f)
    
    # Initialize domain fronter
    fronter = DomainFronter(config)
    
    # Wait for pool warmup
    print("Waiting for pool warmup...")
    await asyncio.sleep(3)
    
    # Test data (minimal SSH hello)
    test_data = b"SSH-2.0-TestClient\r\n"
    
    print(f"\nTesting TCP tunnel relay with:")
    print(f"  Tunnel ID: test-tunnel-001")
    print(f"  Target: 127.0.0.1:22")
    print(f"  Data: {test_data}")
    print(f"  Mode: {config.get('tcp_tunnel', {}).get('mode', 'apps_script')}")
    print()
    
    try:
        response = await fronter.relay_tcp_tunnel(
            tunnel_id="test-tunnel-001",
            target_host="127.0.0.1",
            target_port=22,
            data=test_data
        )
        
        print(f"\n✓ Success! Received {len(response)} bytes:")
        print(f"  Response: {response[:100]}")
        print(f"  Decoded: {response.decode('utf-8', errors='replace')[:100]}")
        return True
        
    except Exception as e:
        print(f"\n✗ Error: {e}")
        import traceback
        traceback.print_exc()
        return False
    
    finally:
        await fronter.close()

if __name__ == "__main__":
    success = asyncio.run(test_relay_tcp_tunnel())
    sys.exit(0 if success else 1)
