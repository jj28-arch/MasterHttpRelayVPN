"""
Unit and integration tests for TCP tunnel functionality.

Tests protocol detection, tunnel state management, relay operations,
and end-to-end connectivity.
"""

import asyncio
import base64
import json
import pytest
import sys
import os
from unittest.mock import Mock, AsyncMock, patch, MagicMock

# Add src directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from proxy.tcp_tunnel import TunnelMode, TunnelState, TCPTunnelServer
import time


class TestTunnelMode:
    """Test TunnelMode enum values."""
    
    def test_tunnel_modes_exist(self):
        """Verify all tunnel modes are defined."""
        assert TunnelMode.GOOGLE_APPS_SCRIPT.value == "apps_script"
        assert TunnelMode.CLOUDFLARE_WEBSOCKET.value == "cloudflare"
        assert TunnelMode.VPS_DIRECT.value == "vps"
    
    def test_tunnel_mode_from_string(self):
        """Test creating tunnel mode from string."""
        mode = TunnelMode("apps_script")
        assert mode == TunnelMode.GOOGLE_APPS_SCRIPT


class TestTunnelState:
    """Test TunnelState dataclass."""
    
    def test_tunnel_state_creation(self):
        """Test creating a tunnel state."""
        now = time.time()
        state = TunnelState(
            tunnel_id="test-123",
            target_host="example.com",
            target_port=22,
            created_at=now,
            last_activity=now,
            last_ping=now,
            mode=TunnelMode.GOOGLE_APPS_SCRIPT,
        )
        
        assert state.tunnel_id == "test-123"
        assert state.target_host == "example.com"
        assert state.target_port == 22
        assert state.mode == TunnelMode.GOOGLE_APPS_SCRIPT
        assert state.seq_send == 0
    
    def test_tunnel_state_buffers(self):
        """Test tunnel state buffer operations."""
        now = time.time()
        state = TunnelState(
            tunnel_id="test-123",
            target_host="example.com",
            target_port=22,
            created_at=now,
            last_activity=now,
            last_ping=now,
            mode=TunnelMode.GOOGLE_APPS_SCRIPT,
        )
        
        # Test buffer initialization
        assert len(state.send_buffer) == 0
        assert len(state.recv_buffer) == 0


class TestProtocolDetection:
    """Test protocol detection from first bytes."""
    
    @pytest.mark.asyncio
    async def test_detect_ssh(self):
        """Test SSH protocol detection."""
        config = {
            "listen_host": "127.0.0.1",
            "listen_port": 9999,
            "mode": "apps_script",
        }
        fronter = AsyncMock()
        server = TCPTunnelServer("127.0.0.1", 9999, fronter, config)
        
        # SSH banner
        ssh_data = b"SSH-2.0-OpenSSH_7.4\r\n"
        protocol = server._detect_protocol(ssh_data)
        assert protocol == "SSH"
    
    @pytest.mark.asyncio
    async def test_detect_tls(self):
        """Test TLS protocol detection."""
        config = {
            "listen_host": "127.0.0.1",
            "listen_port": 9999,
            "mode": "apps_script",
        }
        fronter = AsyncMock()
        server = TCPTunnelServer("127.0.0.1", 9999, fronter, config)
        
        # TLS Client Hello
        tls_data = b"\x16\x03\x01\x00\x4a\x01\x00\x00\x46"
        protocol = server._detect_protocol(tls_data)
        assert protocol == "TLS"
    
    @pytest.mark.asyncio
    async def test_detect_dns(self):
        """Test DNS protocol detection."""
        config = {
            "listen_host": "127.0.0.1",
            "listen_port": 9999,
            "mode": "apps_script",
        }
        fronter = AsyncMock()
        server = TCPTunnelServer("127.0.0.1", 9999, fronter, config)
        
        # DNS query
        dns_data = b"\x12\x34\x01\x00\x00\x01\x00\x00"
        protocol = server._detect_protocol(dns_data)
        assert protocol == "DNS"
    
    @pytest.mark.asyncio
    async def test_detect_smtp(self):
        """Test SMTP protocol detection."""
        config = {
            "listen_host": "127.0.0.1",
            "listen_port": 9999,
            "mode": "apps_script",
        }
        fronter = AsyncMock()
        server = TCPTunnelServer("127.0.0.1", 9999, fronter, config)
        
        # SMTP greeting
        smtp_data = b"220 mail.example.com ESMTP"
        protocol = server._detect_protocol(smtp_data)
        assert protocol == "SMTP"


class TestTargetExtraction:
    """Test extracting target host:port from protocol."""
    
    @pytest.mark.asyncio
    async def test_extract_ssh_target(self):
        """Test SSH target extraction."""
        config = {
            "listen_host": "127.0.0.1",
            "listen_port": 9999,
            "mode": "apps_script",
            "protocol_ports": {"SSH": 22}
        }
        fronter = AsyncMock()
        server = TCPTunnelServer("127.0.0.1", 9999, fronter, config)
        
        host, port = server._extract_target("SSH")
        assert port == 22
    
    @pytest.mark.asyncio
    async def test_extract_tls_target(self):
        """Test TLS target extraction."""
        config = {
            "listen_host": "127.0.0.1",
            "listen_port": 9999,
            "mode": "apps_script",
            "protocol_ports": {"TLS": 443}
        }
        fronter = AsyncMock()
        server = TCPTunnelServer("127.0.0.1", 9999, fronter, config)
        
        host, port = server._extract_target("TLS")
        assert port == 443


class TestTCPTunnelServer:
    """Test TCPTunnelServer initialization and operations."""
    
    @pytest.mark.asyncio
    async def test_server_initialization(self):
        """Test server initialization."""
        config = {
            "listen_host": "127.0.0.1",
            "listen_port": 9999,
            "mode": "apps_script",
        }
        fronter = AsyncMock()
        server = TCPTunnelServer("127.0.0.1", 9999, fronter, config)
        
        assert server.host == "127.0.0.1"
        assert server.port == 9999
        assert server.mode == TunnelMode.GOOGLE_APPS_SCRIPT
        assert server.fronter == fronter
    
    @pytest.mark.asyncio
    async def test_stats_initialization(self):
        """Test statistics tracking initialization."""
        config = {
            "listen_host": "127.0.0.1",
            "listen_port": 9999,
            "mode": "apps_script",
        }
        fronter = AsyncMock()
        server = TCPTunnelServer("127.0.0.1", 9999, fronter, config)
        
        assert server.stats["tunnels_created"] == 0
        assert server.stats["tunnels_closed"] == 0
        assert server.stats["bytes_sent"] == 0
        assert server.stats["bytes_received"] == 0
        assert server.stats["errors"] == 0


class TestRelayIntegration:
    """Test relay operations with domain fronter."""
    
    @pytest.mark.asyncio
    async def test_relay_chunk_with_data(self):
        """Test relaying a chunk of data through domain fronter."""
        config = {
            "listen_host": "127.0.0.1",
            "listen_port": 9999,
            "mode": "apps_script",
        }
        
        # Mock fronter
        fronter = AsyncMock()
        fronter.relay_tcp_tunnel = AsyncMock(
            return_value=b"response data"
        )
        
        server = TCPTunnelServer("127.0.0.1", 9999, fronter, config)
        
        now = time.time()
        tunnel = TunnelState(
            tunnel_id="test-123",
            target_host="example.com",
            target_port=22,
            created_at=now,
            last_activity=now,
            last_ping=now,
            mode=TunnelMode.GOOGLE_APPS_SCRIPT,
        )
        
        # Send data
        send_data = b"SSH protocol data"
        response = await server._relay_chunk(tunnel, send_data)
        
        # Verify relay was called
        fronter.relay_tcp_tunnel.assert_called_once()
        args = fronter.relay_tcp_tunnel.call_args
        
        # Check arguments
        assert args[0][0] == "test-123"  # tunnel_id
        assert args[0][1] == "example.com"  # target_host
        assert args[0][2] == 22  # target_port
        assert args[0][3] == send_data  # data
        
        # Check response
        assert response == b"response data"
    
    @pytest.mark.asyncio
    async def test_relay_chunk_no_data(self):
        """Test relaying without data (keep-alive ping)."""
        config = {
            "listen_host": "127.0.0.1",
            "listen_port": 9999,
            "mode": "apps_script",
        }
        
        fronter = AsyncMock()
        fronter.relay_tcp_tunnel = AsyncMock(return_value=None)
        
        server = TCPTunnelServer("127.0.0.1", 9999, fronter, config)
        
        now = time.time()
        tunnel = TunnelState(
            tunnel_id="test-123",
            target_host="example.com",
            target_port=22,
            created_at=now,
            last_activity=now,
            last_ping=now,
            mode=TunnelMode.GOOGLE_APPS_SCRIPT,
        )
        
        # Send empty data (ping)
        response = await server._relay_chunk(tunnel, None)
        
        # Should still call relay with empty data
        fronter.relay_tcp_tunnel.assert_called_once()
        assert response is None


class TestTunnelCleanup:
    """Test tunnel cleanup and expiry."""
    
    @pytest.mark.asyncio
    async def test_cleanup_expired_tunnels(self):
        """Test cleanup of expired tunnels."""
        config = {
            "listen_host": "127.0.0.1",
            "listen_port": 9999,
            "mode": "apps_script",
            "tunnel_idle_timeout": 1,  # 1 second
        }
        
        fronter = AsyncMock()
        server = TCPTunnelServer("127.0.0.1", 9999, fronter, config)
        
        # Create old tunnel
        old_time = time.time() - 10  # 10 seconds ago
        old_tunnel = TunnelState(
            tunnel_id="old",
            target_host="example.com",
            target_port=22,
            created_at=old_time,
            last_activity=old_time,
            last_ping=old_time,
            mode=TunnelMode.GOOGLE_APPS_SCRIPT,
        )
        
        # Create fresh tunnel
        now = time.time()
        fresh_tunnel = TunnelState(
            tunnel_id="fresh",
            target_host="example.com",
            target_port=22,
            created_at=now,
            last_activity=now,
            last_ping=now,
            mode=TunnelMode.GOOGLE_APPS_SCRIPT,
        )
        
        # Add to registry
        server.tunnels["old"] = old_tunnel
        server.tunnels["fresh"] = fresh_tunnel
        
        # Cleanup
        await server._cleanup_expired_tunnels()
        
        # Old tunnel should be removed
        assert "old" not in server.tunnels
        # Fresh tunnel should remain
        assert "fresh" in server.tunnels


class TestBase64Encoding:
    """Test base64 encoding/decoding for data relay."""
    
    def test_encode_decode(self):
        """Test base64 round-trip encoding."""
        original = b"SSH-2.0-OpenSSH_7.4\r\n"
        encoded = base64.b64encode(original).decode('ascii')
        decoded = base64.b64decode(encoded)
        
        assert decoded == original
    
    def test_empty_data(self):
        """Test encoding empty data."""
        original = b""
        encoded = base64.b64encode(original).decode('ascii')
        assert encoded == ""
        
        decoded = base64.b64decode(encoded)
        assert decoded == b""


class TestTunnelPayload:
    """Test tunnel payload structure."""
    
    def test_payload_structure(self):
        """Test generating tunnel relay payload."""
        tunnel_id = "test-123"
        target_host = "example.com"
        target_port = 22
        data = b"SSH data"
        
        payload = {
            "k": "auth_key",
            "tunnel_id": tunnel_id,
            "target_host": target_host,
            "target_port": target_port,
            "data": base64.b64encode(data).decode("ascii") if data else ""
        }
        
        # Verify structure
        assert payload["tunnel_id"] == tunnel_id
        assert payload["target_host"] == target_host
        assert payload["target_port"] == target_port
        assert isinstance(payload["data"], str)
        
        # Verify we can decode it
        decoded = base64.b64decode(payload["data"])
        assert decoded == data


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
