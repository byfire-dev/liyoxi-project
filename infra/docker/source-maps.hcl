variable "TAG" { default = "unconfigured" }
variable "SOURCE" { default = "unconfigured" }
variable "REPOSITORY_URL" { default = "unconfigured" }
variable "MAPS_DIR" { default = "/dev/null/lyx-source-maps" }

group "server-bundle" { targets = ["server", "server-maps"] }
group "gateway-bundle" { targets = ["gateway", "gateway-maps"] }

target "common" {
  context = "."
  args = { LYX_BUILD = TAG }
  labels = {
    "org.opencontainers.image.source" = REPOSITORY_URL
    "org.opencontainers.image.revision" = SOURCE
  }
}
target "server-build" {
  inherits = ["common"]
  dockerfile = "infra/docker/server/Dockerfile"
}
target "server" {
  inherits = ["server-build"]
  target = "server"
  tags = ["liyoxi/server:${TAG}"]
  output = ["type=docker"]
}
target "server-maps" {
  inherits = ["server-build"]
  target = "source-maps"
  output = ["type=local,dest=${MAPS_DIR}/server"]
}
target "gateway-build" {
  inherits = ["common"]
  dockerfile = "infra/docker/gateway/Dockerfile"
}
target "gateway" {
  inherits = ["gateway-build"]
  target = "gateway"
  tags = ["liyoxi/gateway:${TAG}"]
  output = ["type=docker"]
}
target "gateway-maps" {
  inherits = ["gateway-build"]
  target = "source-maps"
  output = ["type=local,dest=${MAPS_DIR}/gateway"]
}
