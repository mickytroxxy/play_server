#!/bin/bash

# Check if fpcalc is installed
if ! command -v fpcalc &> /dev/null; then
    echo "Error: fpcalc (Chromaprint) is not installed."
    echo "Please install it using one of the following methods:"
    echo ""
    echo "For Ubuntu/Debian:"
    echo "  sudo apt-get update && sudo apt-get install -y libchromaprint-tools"
    echo ""
    echo "For macOS:"
    echo "  brew install chromaprint"
    echo ""
    echo "For other systems, please visit: https://acoustid.org/chromaprint"
    echo ""
    echo "Alternatively, use the provided Dockerfile to build and run the application in a container."
    exit 1
fi

# Start the application
node index.js
