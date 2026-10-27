FROM alpine:3.23
RUN apk add --no-cache ffmpeg
CMD ["ffprobe", "-version"]
