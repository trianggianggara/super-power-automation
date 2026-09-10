# ==============================================================================
# RUNNER: APPLICATION LATEST
# ==============================================================================
# Starts from the prebuilt asset image containing node_modules.
# This builds instantaneously on every code change.
FROM nbsbayu/reg-outlook:asset

WORKDIR /app

# Copy project source code
# Copy selected source files specifically for Outlook
COPY registrars/register_outlook.js registrars/register_outlook_graph.js ./registrars/
COPY runners/parallel.js runners/loop.js ./runners/
COPY tools/ ./tools/
COPY services/tempmail/tempmail.js ./services/tempmail/
COPY utils/ ./utils/

# Create placeholder directories/files for volume mounts if they do not exist
RUN mkdir -p data \
    && touch http_proxies.txt \
    && touch data/outlook_accounts.csv \
    && touch data/outlook_failed_proxies.txt

# Run the Outlook registration script in parallel looping mode inside Xvfb (Virtual Framebuffer Display Server)
# with lightweight 16-bit color depth and disabled GLX software 3D rendering to save CPU.
CMD ["xvfb-run", "--server-args=-screen 0 1024x768x16 -nolisten tcp -extension GLX", "node", "runners/parallel.js", "registrars/register_outlook.js"]
