{
  config,
  lib,
  pkgs,
  ...
}: let
  # These flags cause a Bazel build to use LRE toolchains regardless of whether
  # the build is running in local or remote configuration.
  #
  # To make a remote executor compatible, make the remote execution image (for
  # instance `nativelink-worker-lre-cc` available to the build.
  #
  # To make local execution compatible, add the `lre.installationscript` to the
  # flake's `mkShell.shellhook`:
  #
  # ```nix
  # devShells.default = pkgs.mkShell {
  #   shellHook = ''
  #   # Generate the `lre.bazelrc` config file.
  #   ${config.local-remote-execution.installationScript}
  #   '';
  # };
  # ```
  defaultConfig = [
    # TODO(aaronmondal): Remove after resolution of:
    # https://github.com/bazelbuild/bazel/issues/19714#issuecomment-1745604978
    "--action_env=BAZEL_DO_NOT_DETECT_CPP_TOOLCHAIN=1"

    # TODO(aaronmondal): Remove after resolution of:
    # https://github.com/bazelbuild/bazel/issues/7254
    "--define=EXECUTOR=remote"

    # Set up the default toolchains.
    # TODO(aaronmondal): Implement a mechanism that autogenerates these values
    #                    and generalizes to extensions of the lre-cc base
    #                    toolchain (such as CUDA extensions).
    "--extra_execution_platforms=@local-remote-execution//generated-cc/config:platform"
    "--extra_toolchains=@local-remote-execution//generated-cc/config:cc-toolchain"
  ];

  maybeEnv =
    if config.Env == []
    then ["#" "# WARNING: No environment set. LRE will not work locally."]
    else ["#"] ++ (map (x: "# " + x) config.Env);

  # If the `local-remote-execution.settings.prefix` is set to a nonempty string,
  # prefix the Bazel build commands with that string. This will disable LRE
  # by default and require adding `--config=<prefix>` to Bazel invocations.
  maybePrefixedConfig =
    if (config.prefix == "")
    then map (x: "build " + x) defaultConfig
    else map (x: "build:" + config.prefix + " " + x) defaultConfig;

  configFile = pkgs.runCommand ".bazelrc.lre" {} ''
    printf '# These flags are dynamically generated by the LRE flake module.
    #
    # Add `try-import %%workspace%%/lre.bazelrc` to your .bazelrc to
    # include these flags when running Bazel in a nix environment.

    # These are the paths used by your local LRE config. If you get cache misses
    # between local and remote execution, double-check these values against the
    # toolchain configs in the `@local-remote-execution` repository at the
    # commit that you imported in your `MODULE.bazel`.
    ${lib.concatLines maybeEnv}
    # Bazel-side configuration for LRE.
    ${lib.concatLines maybePrefixedConfig}' >$out
  '';
in {
  options = {
    installationScript = lib.mkOption {
      type = lib.types.str;
      description = lib.mkDoc ''
        A bash snippet which creates a lre.bazelrc file in the repository.
      '';
    };
    Env = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      description = lib.mdDoc ''
        The environment that makes up the LRE toolchain.

        For instance, to make the the environment from the lre-cc toolchain
        available through the `local-remote-execution.installationScript`:

        ```nix
        inherit (lre-cc.meta) Env;
        ```

        To add a tool to the local execution environment withoug adding it to
        the remote environment:

        ```nix
        Env = [ pkgs.some_local_tool ];
        ```

        If you require toolchains that aren't available in the default LRE
        setups:

        ```
        let
          // A custom remote execution container.
          myCustomToolchain = let
            Env = [
              "PATH=''${pkgs.somecustomTool}/bin"
            ];
          in nix2container.buildImage {
            name = "my-custom-toolchain";
            maxLayers = 100;
            config = {inherit Env;};
            meta = {inherit Env;};
          };
        in
        Env = lre-cc.meta.Env ++ myCustomToolchain.meta.Env;
        ```

        The evaluated contents of `Env` are printed in `lre.bazelrc`, this
        causes nix to put these dependencies into your local nix store, but
        doesn't influence any other tooling like Bazel builds.
      '';
      default = [];
    };
    prefix = lib.mkOption {
      type = lib.types.str;
      description = lib.mdDoc ''
        An optional Bazel config prefix for the flags in `lre.bazelrc`.

        If set, builds need to explicitly enable the LRE config via
        `--config=<prefix>`.

        Defaults to an empty string, enabling LRE by default.
      '';
      default = "";
    };
  };

  config = {
    installationScript = ''
      if ! type -t git >/dev/null; then
        # In pure shells
        echo 1>&2 "WARNING: LRE: git command not found; skipping installation."
      elif ! ${pkgs.git}/bin/git rev-parse --git-dir &> /dev/null; then
        echo 1>&2 "WARNING: LRE: .git not found; skipping installation."
      else
        GIT_WC=`${pkgs.git}/bin/git rev-parse --show-toplevel`

        # These update procedures compare before they write, to avoid
        # filesystem churn. This improves performance with watch tools like
        # lorri and prevents installation loops by lorri.

        if ! readlink "''${GIT_WC}/lre.bazelrc" >/dev/null \
          || [[ $(readlink "''${GIT_WC}/lre.bazelrc") != ${configFile} ]]; then
          echo 1>&2 "LRE: updating $PWD repository"
          [ -L lre.bazelrc ] && unlink lre.bazelrc

          if [ -e "''${GIT_WC}/lre.bazelrc" ]; then
            echo 1>&2 "LRE: WARNING: Refusing to install because of pre-existing lre.bazelrc"
            echo 1>&2 "  Remove the lre.bazelrc file and add lre.bazelrc to .gitignore."
          else
            ln -fs ${configFile} "''${GIT_WC}/lre.bazelrc"
          fi
        fi
      fi
    '';
  };
}
