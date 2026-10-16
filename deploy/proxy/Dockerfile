FROM nginx:1.30.6-alpine3.24-slim@sha256:3028fc1419f99b95c1c69f844bbaf49dc1b881750c51b497fc721ac4f02a14e6
RUN apk upgrade --no-cache \
    && find /usr /bin /sbin -xdev -type f -perm /6000 -exec chmod a-s {} +
# The official slim variant omits the unused XML/image/Perl dynamic modules.
# Retain the APK database and upstream licenses for identification and audit.
