FROM eclipse-temurin:17-jdk AS build
ENV LC_ALL=C.UTF-8 JAVA_TOOL_OPTIONS=-Dfile.encoding=UTF-8
ENV ANDROID_HOME=/opt/android-sdk ANDROID_SDK_ROOT=/opt/android-sdk
RUN apt-get update && apt-get install -y --no-install-recommends unzip curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN mkdir -p $ANDROID_HOME/cmdline-tools && cd /tmp \
 && curl -fsSL -o cmd.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip \
 && unzip -q cmd.zip -d $ANDROID_HOME/cmdline-tools && mv $ANDROID_HOME/cmdline-tools/cmdline-tools $ANDROID_HOME/cmdline-tools/latest && rm cmd.zip
RUN yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses > /dev/null \
 && $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager "platforms;android-34" "build-tools;34.0.0"
RUN cd /tmp && curl -fsSL -o g.zip https://services.gradle.org/distributions/gradle-8.7-bin.zip && unzip -q g.zip -d /opt && rm g.zip
ENV PATH=/opt/gradle-8.7/bin:$PATH
WORKDIR /src
COPY apps.tar.gz /tmp/apps.tar.gz
RUN tar xzf /tmp/apps.tar.gz -C /src
RUN gradle --no-daemon --console=plain :user:assembleDebug :admin:assembleDebug
RUN mkdir /out && cp user/build/outputs/apk/debug/user-debug.apk /out/user.apk && cp admin/build/outputs/apk/debug/admin-debug.apk /out/admin.apk

FROM python:3.12-slim
COPY --from=build /out /srv/www
WORKDIR /srv/www
CMD ["sh", "-c", "python -m http.server ${PORT:-10000}"]
