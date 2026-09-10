# ==============================================================================
# RUNNER: APPLICATION LATEST
# ==============================================================================
# Starts from the prebuilt asset image containing node_modules.
# This builds instantaneously on every code change.
FROM nbsbayu/reg-github:asset

WORKDIR /app

# Copy project source code
# Copy selected source files specifically for GitHub
COPY registrars/register_github.js ./registrars/
COPY runners/parallel.js runners/loop.js ./runners/
COPY tools/fetch_and_test_proxies.js ./tools/
COPY services/tempmail/tempmail.js ./services/tempmail/
COPY utils/env.js utils/browser.js utils/proxy.js utils/helpers.js utils/names.js utils/email.js utils/outlook.js utils/outlook_web.js utils/captcha_solver.js ./utils/

# Create placeholder directories/files for volume mounts if they do not exist
RUN mkdir -p data \
    && touch http_proxies.txt \
    && touch data/github_accounts.csv \
    && touch data/github_failed_proxies.txt

# Run the GitHub registration script in parallel looping mode inside Xvfb (Virtual Framebuffer Display Server)
# with lightweight 16-bit color depth and disabled GLX software 3D rendering to save CPU.
CMD ["xvfb-run", "--server-args=-screen 0 1024x768x16 -nolisten tcp -extension GLX", "node", "runners/parallel.js", "registrars/register_github.js"]
