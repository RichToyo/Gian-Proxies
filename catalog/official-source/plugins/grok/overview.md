# Grok Build

Grok Build Proxy 0.4.0 connects Gian to the official Grok CLI 1.0.92 Runtime through its ACP stdio agent (`grok agent --no-leader stdio`). One Grok process serves a session and its Side Chats; it stops after ten idle minutes and the next message resumes the native session.
